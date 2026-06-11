import mongo from "./db";
import { save_jobcode_state, get_sync_state, cursor_progress, safe_cursor, CURSOR_EPOCH } from "./sync_state";
import { create_qbt_object_map_item, primary_by_our_id } from "./qbt_object_map";
import { qbt_client, qbt_jobcode, fetch_all_by_ids } from "./qbt_client_interface";
import {
    change_info,
    find_value_change_item,
    INVALID_IND,
    is_active,
    make_ci_now,
    value_change_item,
} from "./uobj_common";
import { is_awarded, EMP_ACTIVE_ROLE_KEYS, reconcile_jc_assignments_by_jobcode } from "./assignments";

// Collect the hresource ids linked to a contract under any employee role.
export function emp_hres_ids(cont: contract_route_doc): Set<string> {
    const ids = new Set<string>();
    for (const [role_key, links] of Object.entries(cont.assignments)) {
        if (!EMP_ACTIVE_ROLE_KEYS.has(role_key)) continue;
        for (const link of links) {
            if (link.emp_id) ids.add(link.emp_id);
        }
    }
    return ids;
}

type byte = number;

type crole_link = {
    emp_id: string;
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

export function get_current_route_name(cont: contract_route_doc): string {
    const ind = find_value_change_item(cont.route_names, new Date());
    return ind !== INVALID_IND ? cont.route_names[ind].val : "";
}

// The QBT jobcode display name: route_num with the route name in parens so the
// jobcode is identifiable, since route_num is not guaranteed unique. Falls back to
// whichever piece is present (route name alone when there's no route_num).
function jobcode_name(cont: contract_route_doc): string {
    const rname = get_current_route_name(cont);
    if (cont.route_num && rname) return `${cont.route_num} (${rname})`;
    return cont.route_num || rname;
}

export function should_have_active_qbt_jobcode(cont: contract_route_doc): boolean {
    return is_active(cont.archived_info.on) && is_awarded(cont);
}

export function get_contract_log_str(cont: contract_route_doc) {
    const rnum = cont.route_num ? " -- " + cont.route_num : "";
    return `${get_current_route_name(cont)}${rnum} (${cont._id})`;
}

export function get_jobcode_log_str(jc: qbt_jobcode) {
    return `${jc.name} (${jc.id})`;
}

async function process_contract_update(cont: contract_route_doc, qbt: qbt_client): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_active_qbt_jobcode(cont);
    // A contract may have several linked QBT jobcodes (historical duplicates);
    // reconcile the primary (lowest link_id) — the canonical live jobcode. Duplicates
    // are archived and only kept so their old timesheets resolve inbound.
    const mapping = await map_col.findOne({ type: "jobcode", our_id: cont._id }, { sort: { link_id: 1 } });

    let jci: qbt_jobcode | null = null;
    if (mapping) {
        jci = await qbt.fetch_jobcode(mapping.qbt_id);
        const updates: Partial<qbt_jobcode> = {};

        // We can only update a jobcode if it is active (besides setting active to true). QBT also allows
        // other updates on archived jobcodes as long as one of updates is setting the jobcode to active
        if (want) {
            if (!jci.active) updates.active = true;
            const desired_name = jobcode_name(cont);
            if (cont.route_num && jci.name !== desired_name) updates.name = desired_name;
        } else if (jci.active) {
            updates.active = false;
        }
        if (Object.keys(updates).length > 0) {
            jci = await qbt.update_jobcode(jci.id, updates);
            ilog(`[jc] Updated ${get_jobcode_log_str(jci)} with:`, updates);

            // We don't really HAVE to update the mapping, but it could help with debugging to see that our mod dates match
            const qbt_update = {
                $set: {
                    qbt_modified: new Date(jci.last_modified),
                    last_update: make_ci_now(),
                },
            };
            await map_col.updateOne({ _id: mapping._id }, qbt_update);
            ilog(`[jc] Updated mapping ${mapping._id} with updated jc last mod ${jci.last_modified}`);
        } else {
            ilog(`[jc] No changes`);
        }
    } else if (want) {
        jci = await qbt.create_jobcode({
            name: jobcode_name(cont),
            jobcode_type: "regular",
        });
        const new_map_obj = create_qbt_object_map_item(jci.id, cont._id, "jobcode", new Date(jci.last_modified));
        await map_col.insertOne(new_map_obj);
        ilog(`[jc] Created:`, jci, `and associated mapping ${new_map_obj._id}`);
    } else {
        ilog(`[jc] No changes`);
    }

    // Reconcile this jobcode's assignments now that its active state is settled.
    if (!jci) return;
    if (!jci.active) {
        ilog(
            `[jca] Starting sync - archiving any assignments for ${get_contract_log_str(cont)} (jc: ${get_jobcode_log_str(jci)})`
        );
        await reconcile_jc_assignments_by_jobcode(qbt, jci.id, new Set());
        return;
    }

    const hres_ids = [...emp_hres_ids(cont)];
    const desired = new Set<number>();
    if (hres_ids.length > 0) {
        const user_maps = await map_col.find({ type: "user", our_id: { $in: hres_ids } }).toArray();
        // Assign the primary user per hres; duplicate-link users are archived
        // leftovers we don't push new assignments onto.
        const qbt_user_ids = [...primary_by_our_id(user_maps).values()].map((r) => r.qbt_id);
        const usrs = await fetch_all_by_ids(qbt_user_ids, (ids) => qbt.fetch_users({ ids, active: "yes" }));
        usrs.forEach((u) => desired.add(u.id));
    }
    ilog(
        `[jca] Starting sync - ${desired.size} desired assignments for ${get_contract_log_str(cont)} (jc: ${get_jobcode_log_str(jci)})`
    );
    await reconcile_jc_assignments_by_jobcode(qbt, jci.id, desired);
}

export async function update_jobcodes_from_contracts(qbt: qbt_client): Promise<void> {
    const state = get_sync_state();
    const since = state.jobcodes.last_synced ?? CURSOR_EPOCH;
    ilog(`[jc] Delta sync since ${since.toISOString()}`);

    const changed = await mongo
        .get_conts()
        .find({ "last_update.on": { $gt: since } })
        .toArray();

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    for (let i = 0; i < changed.length; ++i) {
        const cont = changed[i];
        const at = cont.last_update.on;
        ilog(`[jc] Processing update for ${get_contract_log_str(cont)} (${i + 1} of ${changed.length})`);
        try {
            await process_contract_update(cont, qbt);
            if (at > progress.latest_resolved) progress.latest_resolved = at;
        } catch (err) {
            elog(`[jc] Error syncing contract ${get_contract_log_str(cont)}:`, err);
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
