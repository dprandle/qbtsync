import "./global_setup";
import { config } from "./config";
import mongo from "./db";
import type { AnyBulkWriteOperation } from "mongodb";
import { ensure_state_file_writable, save_jobcode_state, save_user_state, get_sync_state } from "./sync_state";
import { create_qbt_object_map_item, type qbt_object_map } from "./qbt_object_map";
import { is_active } from "./uobj_common";
import { qbt_client, qbt_jobcode, qbt_user, active_param } from "./qbt_client_interface";
import { qbt_api_client } from "./qbt_client";
import { qbt_mock_client } from "./qbt_mock_client";
import { is_awarded, EMP_MGR_ROLE_KEYS } from "./assignments";
import { contract_route_doc, get_current_route_name, get_contract_log_str, get_jobcode_log_str } from "./sync_jobcodes";
import { hresource_doc, normalize_email, get_user_log_str, get_hres_log_str } from "./sync_users";
import { ask_yes_no } from "./util";

// One-time bootstrap, run as its own entrypoint (npm run bootstrap) before the
// sync service is ever started. It matches existing QBT jobcodes/users to our
// contracts/hresources by heuristics (route-name regexp, email, role-list
// membership) that are only valid at first import — once mappings exist the sync
// service maintains them, and these heuristics are not kept up to date. The sync
// service refuses to start until both bootstraps below have completed.

// ---------------------------------------------------------------------------
// Jobcodes: match by route name
// ---------------------------------------------------------------------------
// A route code is a delimited five-character alphanumeric token (FIVE_RE), optionally
// followed by a "-<letter>" suffix (SEVEN_RE). Matching is case-sensitive by design:
// codes are always uppercase, so the character classes are uppercase-only. The
// surrounding (?:^|[^A-Za-z0-9]) / lookahead anchors require the token to be delimited
// so it isn't pulled out of a longer alphanumeric run.
const SEVEN_RE = /(?:^|[^A-Za-z0-9])([A-Z0-9]{5}-[A-Z])(?=$|[^A-Za-z0-9])/;
const FIVE_RE = /(?:^|[^A-Za-z0-9])([A-Z0-9]{5})(?=$|[^A-Za-z0-9])/;

// Pull the route code out of a jobcode name, preferring the longer suffixed form.
// Returns "" when the name carries no recognizable code (those jobcodes go unmatched).
function extract_cont_rname(jc_name: string): string {
    const seven_match = jc_name.match(SEVEN_RE);
    if (seven_match) return seven_match[1];

    const five_match = jc_name.match(FIVE_RE);
    if (five_match) return five_match[1];

    return "";
}

// A set of awarded contracts to match against: an exact current-route-name index
// for fast lookup, plus the full list (scanned for historical route-name matches).
type awarded_pool = {
    by_rname: Map<string, contract_route_doc>;
    all: contract_route_doc[];
};

// Active contracts are matched before archived ones, so each is kept as its own pool.
type awarded_pools = {
    act: awarded_pool;
    arch: awarded_pool;
};

// First see if we find a match for any current contract route name. If no match is found, search through all route names.
function find_matching_contract(jc: qbt_jobcode, pools: awarded_pools): contract_route_doc | null {
    const rname = extract_cont_rname(jc.name);
    if (!rname) {
        return null;
    }

    let match = pools.act.by_rname.get(rname);
    if (!match) {
        match = pools.arch.by_rname.get(rname);
    }
    if (!match) {
        match = pools.act.all.find((c) => c.route_names.some((chg_val) => rname === chg_val.val));
    }
    if (!match) {
        match = pools.arch.all.find((c) => c.route_names.some((chg_val) => rname === chg_val.val));
    }
    return match ?? null;
}

async function bootstrap_jobcodes_loop(
    qbt: qbt_client,
    pools: awarded_pools,
    active: active_param
): Promise<qbt_jobcode[]> {
    const map_col = mongo.get_qbt_map_objects();
    let page = 1;
    let nomatches: qbt_jobcode[] = [];
    while (true) {
        const { items: jobcodes, more } = await qbt.fetch_jobcodes({ page, active });
        ilog(
            `[jc] Trying to match ${jobcodes.length} ${active === "yes" ? "active" : "archived"} jobcodes to uber contracts`
        );

        // Prefetch which of this page's jobcodes are already linked, so the (relatively
        // expensive) contract name match only runs for the ones that still need it.
        const by_qbt_docs = await map_col
            .find({ type: "jobcode", qbt_id: { $in: jobcodes.map((j) => j.id) } })
            .toArray();
        const linked_qbt = new Map(by_qbt_docs.map((m) => [m.qbt_id, m]));

        // Match the unlinked jobcodes to contracts up front so we know which our_ids to prefetch.
        const matched_cont = new Map<number, contract_route_doc>(); // jobcode id -> contract
        for (const jc of jobcodes) {
            if (linked_qbt.has(jc.id)) continue;
            const match = find_matching_contract(jc, pools);
            if (match) matched_cont.set(jc.id, match);
        }

        // Prefetch existing links by our_id so re-runs continue the sequence rather
        // than colliding. A contract may now carry several links (historical duplicate
        // jobcodes), so track the highest link_id seen per contract; max_link is
        // written through below so two duplicates matching the same contract within one
        // page also get distinct, increasing link_ids.
        const by_our_docs = await map_col
            .find({ type: "jobcode", our_id: { $in: [...new Set([...matched_cont.values()].map((c) => c._id))] } })
            .toArray();
        const max_link = new Map<string, number>();
        for (const m of by_our_docs) {
            max_link.set(m.our_id, Math.max(max_link.get(m.our_id) ?? -1, m.link_id ?? 0));
        }
        const inserts: AnyBulkWriteOperation<qbt_object_map>[] = [];

        for (const jc of jobcodes) {
            const existing = linked_qbt.get(jc.id);
            if (existing) {
                ilog(`[jc] Already matched ${get_jobcode_log_str(jc)} to contract ${existing.our_id} - skipping`);
                continue;
            }

            const match = matched_cont.get(jc.id);
            if (!match) {
                nomatches.push(jc);
                continue;
            }

            // Link every matching jobcode, not just the first. Active jobcodes are
            // bootstrapped before archived ones, so the live jobcode takes link_id 0
            // (the primary used for outbound writes) and archived duplicates take
            // higher ids, kept only so their old timesheets resolve inbound.
            const link_id = (max_link.get(match._id) ?? -1) + 1;
            max_link.set(match._id, link_id);
            const map_obj = create_qbt_object_map_item(jc.id, match._id, "jobcode", new Date(jc.last_modified), link_id);
            inserts.push({ insertOne: { document: map_obj } });
            ilog(
                `[jc] Bootstrap linked contract ${get_contract_log_str(match)} → ${get_jobcode_log_str(jc)} (link ${link_id})`
            );
        }

        if (inserts.length > 0) await mongo.with_transaction((session) => map_col.bulkWrite(inserts, { session }));
        if (!more) break;
        page++;
    }
    return nomatches;
}

export async function bootstrap_jobcodes(qbt: qbt_client): Promise<void> {
    if (get_sync_state().jobcodes.bootstrap_complete) return;
    ilog("[jc] Running bootstrap: matching jobcodes to contracts by route name...");

    // Load all contracts to search against
    const all_conts = await mongo.get_conts().find({}).toArray();
    const awd_conts = all_conts.filter((c) => {
        return is_awarded(c);
    });
    const act_awd_conts = awd_conts.filter((c) => {
        return is_active(c.archived_info.on);
    });
    const arch_awd_conts = awd_conts.filter((c) => {
        return !is_active(c.archived_info.on);
    });

    const build_pool = (conts: contract_route_doc[]): awarded_pool => {
        const by_rname: Map<string, contract_route_doc> = new Map();
        for (const c of conts) {
            const cur_rname = get_current_route_name(c);
            if (!cur_rname) continue;
            const existing = by_rname.get(cur_rname);
            if (existing) {
                throw new Error(
                    `Duplicate awarded contract for rname ${cur_rname} -- existing: ${existing._id} dup: ${c._id}`
                );
            }
            by_rname.set(cur_rname, c);
        }
        return { by_rname, all: conts };
    };

    const pools: awarded_pools = {
        act: build_pool(act_awd_conts),
        arch: build_pool(arch_awd_conts),
    };

    // We want to match all active jobcodes first, then look at archived ones
    const active_nomatches = await bootstrap_jobcodes_loop(qbt, pools, "yes");
    const archived_nomatches = await bootstrap_jobcodes_loop(qbt, pools, "no");
    for (const jc of archived_nomatches) {
        ilog(`[jc] Could not find matching contract for archived ${get_jobcode_log_str(jc)}`);
    }

    for (let i = 0; i < active_nomatches.length; ++i) {
        const answer = await ask_yes_no(
            `[jc] Archive ${get_jobcode_log_str(active_nomatches[i])} (${i + 1} of ${active_nomatches.length})?`
        );
        if (answer) {
            const result = await qbt.update_jobcode(active_nomatches[i].id, { active: false });
            ilog(`[jc] Updated ${get_jobcode_log_str(result)} to ${result.active ? "active" : "archived"}`);
        }
    }

    save_jobcode_state({ bootstrap_complete: true });
    ilog("[jc] Bootstrap complete.");
}

// ---------------------------------------------------------------------------
// Users: match by email
// ---------------------------------------------------------------------------

async function bootstrap_users_loop(
    qbt: qbt_client,
    hres_by_email: Map<string, hresource_doc>,
    hres_by_name: Map<string, hresource_doc>,
    active: active_param
): Promise<qbt_user[]> {
    const map_col = mongo.get_qbt_map_objects();
    let page = 1;
    let nomatches: qbt_user[] = [];
    while (true) {
        const { items: users, more } = await qbt.fetch_users({ page, active });
        ilog(`[usi] Trying to match ${users.length} ${active === "yes" ? "active" : "archived"} users to hres`);

        // Match emails up front (cheap, in-memory) so we know which hres ids to prefetch.
        const matched_hres = new Map<number, hresource_doc>(); // qbt user id -> hres
        for (const qusr of users) {
            const uname = normalize_full_name(qusr.first_name, qusr.last_name);
            const hres =
                hres_by_email.get(normalize_email(qusr.email)) ??
                hres_by_email.get(normalize_email(qusr.username)) ??
                hres_by_name.get(uname) ??
                (qusr.id == 1127534 ? hres_by_email.get("daniel@zetrickllc.com") : null);
            if (hres) matched_hres.set(qusr.id, hres);
        }

        // Prefetch existing maps for this page: by qbt_id (this QBT user already
        // linked → idempotent skip) and by our_id (existing links for the matched
        // hres). An hres may now carry several links (historical duplicate users), so
        // track the highest link_id per hres; max_link is written through below so two
        // duplicates matching the same hres within one page get distinct link_ids.
        const [by_qbt_docs, by_our_docs] = await Promise.all([
            map_col.find({ type: "user", qbt_id: { $in: users.map((u) => u.id) } }).toArray(),
            map_col
                .find({ type: "user", our_id: { $in: [...new Set([...matched_hres.values()].map((h) => h._id))] } })
                .toArray(),
        ]);
        const linked_qbt = new Map(by_qbt_docs.map((m) => [m.qbt_id, m]));
        const max_link = new Map<string, number>();
        for (const m of by_our_docs) {
            max_link.set(m.our_id, Math.max(max_link.get(m.our_id) ?? -1, m.link_id ?? 0));
        }
        const inserts: AnyBulkWriteOperation<qbt_object_map>[] = [];

        for (const qusr of users) {
            // If we already have an entry for this user, skip it
            const existing = linked_qbt.get(qusr.id);
            if (existing) {
                ilog(`[usi] Already matched ${get_user_log_str(qusr)} to hres ${existing.our_id} - skipping`);
                continue;
            }

            const hres = matched_hres.get(qusr.id);
            if (!hres) {
                nomatches.push(qusr);
                continue;
            }

            // Link every matching user, not just the first. Active users are
            // bootstrapped before archived ones, so the live user takes link_id 0
            // (the primary used for outbound writes) and archived duplicates take
            // higher ids, kept only so their old timesheets resolve inbound.
            const link_id = (max_link.get(hres._id) ?? -1) + 1;
            max_link.set(hres._id, link_id);
            const map_obj = create_qbt_object_map_item(qusr.id, hres._id, "user", new Date(qusr.last_modified), link_id);
            inserts.push({ insertOne: { document: map_obj } });
            ilog(`[usi] Bootstrap linked hres ${get_hres_log_str(hres)} → ${get_user_log_str(qusr)} (link ${link_id})`);
        }

        if (inserts.length > 0) await mongo.with_transaction((session) => map_col.bulkWrite(inserts, { session }));
        if (!more) break;
        page++;
    }
    return nomatches;
}

function is_employee_or_mgr(hres: hresource_doc): boolean {
    return hres.allowed_roles.some((r) => EMP_MGR_ROLE_KEYS.has(r.source_str));
}

function normalize_full_name(first_name: string, last_name: string): string {
    const name = (first_name + last_name).toLowerCase();
    name.replace(/\s+/g, "");
    return name;
}

export async function bootstrap_users(qbt: qbt_client): Promise<void> {
    if (get_sync_state().users.bootstrap_complete) return;
    ilog("[usi] Running bootstrap: matching users to hresources by email...");
    const all_hres = await mongo.get_hresources().find({}).toArray();
    const employees_and_mgrs = all_hres.filter((hr) => is_employee_or_mgr(hr));

    // Create faster lookup table - throw for any duplicate emails. We might have duplicate hrs (ie a subc and employee)
    // but we should NOT have duplciates across employee/managers
    const hres_by_email = new Map<string, hresource_doc>();
    for (const h of employees_and_mgrs) {
        const email = normalize_email(h.email);
        const existing = hres_by_email.get(email);
        if (existing) {
            throw new Error(`Duplicate hresource for email ${email} -- existing: ${existing._id} dup: ${h._id}`);
        }
        hres_by_email.set(email, h);
    }

    const hres_by_name = new Map<string, hresource_doc>();
    for (const h of employees_and_mgrs) {
        const name = normalize_full_name(h.first_name, h.last_name);
        const existing = hres_by_name.get(name);
        if (existing) {
            throw new Error(`Duplicate hresource for name ${name} -- existing: ${existing._id} dup: ${h._id}`);
        }
        hres_by_name.set(name, h);
    }

    // Do active users first, then non active users as we want our active ones to take priority
    const active_nomatches = await bootstrap_users_loop(qbt, hres_by_email, hres_by_name, "yes");
    const archived_nomatches = await bootstrap_users_loop(qbt, hres_by_email, hres_by_name, "no");
    for (const u of archived_nomatches) {
        ilog(`[usi] Could not find matching hres for archived ${get_user_log_str(u)}`);
    }

    for (let i = 0; i < active_nomatches.length; ++i) {
        const answer = await ask_yes_no(
            `[usi] Archive ${get_user_log_str(active_nomatches[i])} (${i + 1} of ${active_nomatches.length})?`
        );
        if (answer) {
            const result = await qbt.update_user(active_nomatches[i].id, { active: false });
            ilog(`[usi] Updated ${get_user_log_str(result)} to ${result.active ? "active" : "archived"}`);
        }
    }

    save_user_state({ bootstrap_complete: true });
    ilog("[usi] Bootstrap complete.");
}

// ---------------------------------------------------------------------------
// Entrypoint
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
    ensure_state_file_writable();
    await mongo.connect();
    try {
        let qbt: qbt_client;
        if (config.qbt_env === "dev") {
            ilog("[dev] QBT_ENV=dev — using mock QBT backed by MongoDB (run 'npm run seed_mock_db' to populate it)");
            qbt = new qbt_mock_client();
        } else {
            qbt = new qbt_api_client();
        }

        // Jobcodes before users: user-side assignment reconciliation reads the
        // jobcode mappings this produces. Each is idempotent (gated on its
        // bootstrap_complete flag), so re-running is safe.
        ilog("[bootstrap] Running jobcode + user bootstraps...");
        await bootstrap_jobcodes(qbt);
        await bootstrap_users(qbt);
        ilog("[bootstrap] Complete.");
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[bootstrap] Fatal error:", err);
    process.exit(1);
});
