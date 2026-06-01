import mongo from "./db";
import { save_jobcode_state, get_sync_state, cursor_progress, safe_cursor, CURSOR_EPOCH } from "./sync_state";
import { create_qbt_object_map_item } from "./qbt_object_map";
import { qbt_client, qbt_jobcode, fetch_all_by_ids, active_param } from "./qbt_client_interface";
import { change_info, find_value_change_item, INVALID_IND, is_active, value_change_item } from "./uobj_common";
import { is_awarded, EMP_ROLE_KEYS, reconcile_jc_assignments_by_jobcode } from "./assignments";
import { ask_yes_no } from "./util";

// Collect the hresource ids linked to a contract under any employee role.
function emp_hres_ids(cont: contract_route_doc): Set<string> {
    const ids = new Set<string>();
    for (const [role_key, links] of Object.entries(cont.assignments)) {
        if (!EMP_ROLE_KEYS.has(role_key)) continue;
        for (const link of links) {
            const src = link.emp_id?.source_str;
            if (src) ids.add(src);
        }
    }
    return ids;
}

type byte = number;

type uid = {
    source_str: string;
};

type crole_link = {
    emp_id: uid;
};

export type contract_route_doc = {
    _id: string;
    route_num: string;
    // keys are role_id source_str; each value is an array of crole_link objects
    assignments: Record<string, crole_link[]>;
    archived_info: change_info;
    last_update: change_info;
    route_names: value_change_item<string>[];
    timezone: byte[];
};

function get_current_route_name(cont: contract_route_doc): string {
    const ind = find_value_change_item(cont.route_names, new Date());
    return ind !== INVALID_IND ? cont.route_names[ind].val : "";
}

function should_have_active_qbt_jobcode(cont: contract_route_doc): boolean {
    return is_active(cont.archived_info.on) && is_awarded(cont);
}

function get_contract_log_str(cont: contract_route_doc) {
    const rnum = cont.route_num ? " -- " + cont.route_num : "";
    return `${get_current_route_name(cont)}${rnum} (${cont._id})`;
}

function get_jobcode_log_str(jc: qbt_jobcode) {
    return `${jc.name} (${jc.id})`;
}

// First find see if we find a match for any current contract route name. If no match is found, search through all route names.
function find_matching_contract(jc: qbt_jobcode, all_contracts: contract_route_doc[]) {
    let match = all_contracts.find((c) => {
        const rname = get_current_route_name(c);
        return jc.name.toLowerCase().includes(rname.toLowerCase());
    });
    if (!match) {
        match = all_contracts.find((c) => {
            for (const chg_val of c.route_names) {
                if (jc.name.toLowerCase().includes(chg_val.val.toLowerCase())) {
                    return true;
                }
            }
            return false;
        });
    }
    return match;
}

async function bootstrap_jobcodes_loop(
    qbt: qbt_client,
    awarded_contracts: contract_route_doc[],
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
        for (const jc of jobcodes) {
            const existing = await map_col.findOne({
                type: "jobcode",
                qbt_id: jc.id,
            });
            if (existing) {
                ilog(
                    `[jc] Already matched jobcode ${get_jobcode_log_str(jc)} to contract id ${existing.our_id} - skipping`
                );
                continue;
            }

            const match = find_matching_contract(jc, awarded_contracts);
            if (!match) {
                nomatches.push(jc);
                continue;
            }

            const already_mapped = await map_col.findOne({
                type: "jobcode",
                our_id: match._id,
            });

            if (already_mapped) {
                ilog(
                    `[jc] Found match ${get_contract_log_str(match)} for jc ${get_jobcode_log_str(jc)} but contract already linked to jc ${already_mapped.qbt_id}`
                );
                continue;
            }

            const map_obj = create_qbt_object_map_item(jc.id, match._id, "jobcode", new Date(jc.last_modified));
            await map_col.insertOne(map_obj);
            ilog(
                `[jc] Bootstrap mapped contract ${get_contract_log_str(match)} → QBT jobcode ${get_jobcode_log_str(jc)}`
            );
        }

        if (!more) break;
        page++;
    }
    return nomatches;
}

export async function bootstrap_jobcodes(qbt: qbt_client): Promise<void> {
    if (get_sync_state().jobcodes.bootstrap_complete) return;
    ilog("[jc] Running bootstrap: matching QBT jobcodes to contracts by route name...");

    // Load all contracts to search against
    const all_contracts = await mongo.get_conts().find({}).toArray();
    const all_awarded_contracts = all_contracts.filter((c) => {
        return is_awarded(c);
    });

    // We want to match all active jobcodes first, then look at archived ones
    const active_nomatches = await bootstrap_jobcodes_loop(qbt, all_awarded_contracts, "yes");
    const archived_nomatches = await bootstrap_jobcodes_loop(qbt, all_awarded_contracts, "no");
    for (const jc of archived_nomatches) {
        ilog(`[jc] Could not find matching contract for archived jobcode ${get_jobcode_log_str(jc)}`);
    }

    for (let i = 0; i < active_nomatches.length; ++i) {
        const answer = await ask_yes_no(
            `[jc] Archive ${get_jobcode_log_str(active_nomatches[i])} (${i + 1} of ${active_nomatches.length})?`
        );
        if (answer) {
            const result = await qbt.update_jobcode(active_nomatches[i].id, { active: false });
            ilog(`[jc] Updated jobcode ${get_jobcode_log_str(result)} to ${result.active ? "active" : "archived"}`);
        }
    }

    save_jobcode_state({ bootstrap_complete: true });
    ilog("[jc] Bootstrap complete.");
}

async function process_contract_update(cont: contract_route_doc, qbt: qbt_client): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_active_qbt_jobcode(cont);
    const cur_rname = get_current_route_name(cont);
    const mapping = await map_col.findOne({
        type: "jobcode",
        our_id: cont._id,
    });

    let jci: qbt_jobcode | null = null;
    if (mapping) {
        jci = await qbt.fetch_jobcode(mapping.qbt_id);
        const updates: Partial<qbt_jobcode> = {};
        // We can only update a jobcode if it is active (besides setting active to true). QBT also allows
        // other updates on archived jobcodes as long as one of updates is setting the jobcode to active
        if (want) {
            if (!jci.active) updates.active = true;
            if (cont.route_num && jci.name !== cont.route_num) updates.name = cont.route_num;
        } else if (jci.active) {
            updates.active = false;
        }
        if (Object.keys(updates).length > 0) {
            const new_jci = await qbt.update_jobcode(jci.id, updates);
            ilog(
                `[jc] Updated QBT jobcode`,
                jci,
                `for contract  ${cur_rname} (${cont._id}) with`,
                updates,
                "resulting in",
                new_jci
            );
            jci = new_jci;
        }
    } else if (want) {
        jci = await qbt.create_jobcode({
            name: cont.route_num ?? cur_rname,
            jobcode_type: "regular",
        });
        const new_map_obj = create_qbt_object_map_item(jci.id, cont._id, "jobcode", new Date(jci.last_modified));
        await map_col.insertOne(new_map_obj);
        ilog(`[jc] Created QBT jobcode`, jci, `for contract  ${cur_rname} (${cont._id})`);
    }

    // Reconcile this jobcode's assignments now that its active state is settled.
    if (!jci) return;
    if (!jci.active) {
        await reconcile_jc_assignments_by_jobcode(qbt, jci.id, new Set());
        return;
    }

    const hres_ids = [...emp_hres_ids(cont)];
    const desired = new Set<number>();
    if (hres_ids.length > 0) {
        const user_maps = await map_col.find({ type: "user", our_id: { $in: hres_ids } }).toArray();
        const qbt_user_ids = user_maps.map((r) => r.qbt_id);
        const usrs = await fetch_all_by_ids(qbt_user_ids, (ids) => qbt.fetch_users({ ids, active: "yes" }));
        usrs.forEach((u) => desired.add(u.id));
    }
    await reconcile_jc_assignments_by_jobcode(qbt, jci.id, desired);
}

export async function sync_jobcodes(qbt: qbt_client): Promise<void> {
    const state = get_sync_state();
    const since = state.jobcodes.last_synced ?? CURSOR_EPOCH;
    ilog(`[jc] Delta sync since ${since.toISOString()}`);

    const changed = await mongo
        .get_conts()
        .find({ "last_update.on": { $gt: since } })
        .toArray();

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    for (const cont of changed) {
        const at = cont.last_update.on;
        try {
            await process_contract_update(cont, qbt);
            if (at > progress.latest_resolved) progress.latest_resolved = at;
        } catch (err) {
            elog(`[jc] Error syncing contract ${cont._id}:`, err);
            if (!progress.earliest_unresolved || at < progress.earliest_unresolved) {
                progress.earliest_unresolved = at;
            }
        }
    }

    const latest = safe_cursor(progress, since);
    if (latest > since) {
        save_jobcode_state({ last_synced: latest });
        ilog(`[jc] Cursor advanced to ${latest.toISOString()}`);
    } else {
        ilog("[jc] No contract changes.");
    }
}
