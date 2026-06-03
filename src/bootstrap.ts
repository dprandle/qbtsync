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
import {
    contract_route_doc,
    get_current_route_name,
    get_contract_log_str,
    get_jobcode_log_str,
} from "./sync_jobcodes";
import { hresource_doc, normalize_email, get_user_log_str, get_hres_log_str } from "./sync_users";
import { ask_yes_no } from "./util";

// One-time bootstrap, run as its own entrypoint (npm run bootstrap) before the
// sync service is ever started. It matches existing QBT jobcodes/users to our
// contracts/hresources by heuristics (route-name substring, email, role-list
// membership) that are only valid at first import — once mappings exist the sync
// service maintains them, and these heuristics are not kept up to date. The sync
// service refuses to start until both bootstraps below have completed.

// ---------------------------------------------------------------------------
// Jobcodes: match by route name
// ---------------------------------------------------------------------------

// True when needle is a non-empty substring of the jobcode name. The empty-string
// guard is essential: "".includes("") and `anything.includes("")` are both true, so
// a contract with no (current) route name would otherwise match every jobcode.
function jc_name_contains(jc: qbt_jobcode, needle: string): boolean {
    const n = needle.trim().toLowerCase();
    return n.length > 0 && jc.name.toLowerCase().includes(n);
}

// First find see if we find a match for any current contract route name. If no match is found, search through all route names.
function find_matching_contract(
    jc: qbt_jobcode,
    act_awd_conts: contract_route_doc[],
    arch_awd_conts: contract_route_doc[]
) {
    let match = act_awd_conts.find((c) => jc_name_contains(jc, get_current_route_name(c)));
    if (!match) {
        match = arch_awd_conts.find((c) => jc_name_contains(jc, get_current_route_name(c)));
    }
    if (!match) {
        match = act_awd_conts.find((c) => c.route_names.some((chg_val) => jc_name_contains(jc, chg_val.val)));
    }
    if (!match) {
        match = arch_awd_conts.find((c) => c.route_names.some((chg_val) => jc_name_contains(jc, chg_val.val)));
    }
    return match;
}

async function bootstrap_jobcodes_loop(
    qbt: qbt_client,
    act_awd_conts: contract_route_doc[],
    arch_awd_conts: contract_route_doc[],
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
            const match = find_matching_contract(jc, act_awd_conts, arch_awd_conts);
            if (match) matched_cont.set(jc.id, match);
        }

        // Prefetch existing mappings by our_id. linked_our is written through below so two
        // jobcodes matching the same contract in one page don't both insert — that would
        // violate the unique (type, our_id) index and abort the transaction.
        const by_our_docs = await map_col
            .find({ type: "jobcode", our_id: { $in: [...new Set([...matched_cont.values()].map((c) => c._id))] } })
            .toArray();
        const linked_our = new Map(by_our_docs.map((m) => [m.our_id, m]));
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

            const already_mapped = linked_our.get(match._id);
            if (already_mapped) {
                ilog(
                    `[jc] Found match ${get_contract_log_str(match)} for ${get_jobcode_log_str(jc)} but contract already linked to ${already_mapped.qbt_id}`
                );
                continue;
            }

            const map_obj = create_qbt_object_map_item(jc.id, match._id, "jobcode", new Date(jc.last_modified));
            inserts.push({ insertOne: { document: map_obj } });
            linked_our.set(match._id, map_obj); // write-through: claim this contract for the rest of the page
            ilog(`[jc] Bootstrap mapped contract ${get_contract_log_str(match)} → ${get_jobcode_log_str(jc)}`);
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

    // We want to match all active jobcodes first, then look at archived ones
    const active_nomatches = await bootstrap_jobcodes_loop(qbt, act_awd_conts, arch_awd_conts, "yes");
    const archived_nomatches = await bootstrap_jobcodes_loop(qbt, act_awd_conts, arch_awd_conts, "no");
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
            const hres =
                hres_by_email.get(normalize_email(qusr.email)) ?? hres_by_email.get(normalize_email(qusr.username));
            if (hres) matched_hres.set(qusr.id, hres);
        }

        // Prefetch existing mappings for this page: by qbt_id (this QBT user already
        // linked) and by our_id (this hres already linked). linked_our is written
        // through below so two QBT users matching the same hres in one page don't both
        // insert — that would violate the unique (type, our_id) index and abort the txn.
        const [by_qbt_docs, by_our_docs] = await Promise.all([
            map_col.find({ type: "user", qbt_id: { $in: users.map((u) => u.id) } }).toArray(),
            map_col
                .find({ type: "user", our_id: { $in: [...new Set([...matched_hres.values()].map((h) => h._id))] } })
                .toArray(),
        ]);
        const linked_qbt = new Map(by_qbt_docs.map((m) => [m.qbt_id, m]));
        const linked_our = new Map(by_our_docs.map((m) => [m.our_id, m]));
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

            const already_mapped = linked_our.get(hres._id);
            if (already_mapped) {
                ilog(`[usi] Found match ${get_hres_log_str(hres)} but hres already linked to ${already_mapped.qbt_id}`);
                continue;
            }

            const map_obj = create_qbt_object_map_item(qusr.id, hres._id, "user", new Date(qusr.last_modified));
            inserts.push({ insertOne: { document: map_obj } });
            linked_our.set(hres._id, map_obj); // write-through: claim this hres for the rest of the page
            ilog(`[usi] Bootstrap mapped hres ${get_hres_log_str(hres)} → ${get_user_log_str(qusr)}`);
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

export async function bootstrap_users(qbt: qbt_client): Promise<void> {
    if (get_sync_state().users.bootstrap_complete) return;
    ilog("[usi] Running bootstrap: matching users to hresources by email...");
    const all_hres = await mongo.get_hres().find({}).toArray();
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

    // Do active users first, then non active users as we want our active ones to take priority
    const active_nomatches = await bootstrap_users_loop(qbt, hres_by_email, "yes");
    const archived_nomatches = await bootstrap_users_loop(qbt, hres_by_email, "no");
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
