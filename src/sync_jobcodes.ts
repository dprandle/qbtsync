import mongo from "./db";
import { save_jobcode_state, load_sync_state } from "./sync_state";
import { QBT_ACTIVE, QBT_ARCHIVED, create_qbt_object_map_item } from "./qbt_object_map";
import { qbt_client, qbt_jobcode } from "./qbt_client_interface";
import { change_info, find_value_change_item, INVALID_IND, is_active, value_change_item } from "./uobj_common";
import { is_awarded, EMP_ROLE_KEYS, reconcile_jobcode_assignments } from "./assignments";

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

export type contract_route_doc = {
    _id: string;
    route_num: string;
    // keys are role_id source_str; each value is an array of crole_link objects
    assignments: Record<string, Array<{ emp_id: { source_str: string } }>>;
    archived_info: change_info;
    last_update: change_info;
    route_names: value_change_item<string>[];
};

function get_current_route_name(cont: contract_route_doc): string {
    const ind = find_value_change_item(cont.route_names, new Date());
    return ind !== INVALID_IND ? cont.route_names[ind].val : "";
}

function should_have_active_qbt_jobcode(cont: contract_route_doc): boolean {
    return is_active(cont.archived_info.on) && is_awarded(cont);
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

async function boostrap_jobcodes_loop(qbt: qbt_client, awarded_contracts: contract_route_doc[], active: boolean) {
    const map_col = mongo.get_qbt_map_objects();
    let page = 1;
    while (true) {
        const { items: jobcodes, more } = await qbt.fetch_jobcodes({ page, active });
        console.log(
            `[jobcodes] Trying to match ${jobcodes.length} ${active ? "active" : "archived"} jobcodes to uber contracts`
        );
        for (const jc of jobcodes) {
            const existing = await map_col.findOne({
                type: "jobcode",
                qbt_id: jc.id,
            });
            if (existing) continue;

            const match = find_matching_contract(jc, awarded_contracts);
            if (!match) {
                console.log(`Could not find matching contract for jobcode ${jc.name} (${jc.id})`);
                continue;
            }
            const cur_rname = get_current_route_name(match);

            const already_mapped = await map_col.findOne({
                type: "jobcode",
                our_id: match._id,
            });
            if (already_mapped) {
                console.log(
                    `Found match ${cur_rname} (${match._id}) for jc ${jc.name} (${jc.id}) but contract already linked to ${already_mapped.qbt_status == 1 ? "active" : "archived"} jc ${already_mapped.qbt_id}`
                );
                continue;
            }
            const map_obj = create_qbt_object_map_item(
                jc.id,
                match._id,
                "jobcode",
                jc.active ? QBT_ACTIVE : QBT_ARCHIVED,
                new Date(jc.last_modified)
            );
            await map_col.insertOne(map_obj);
            console.log(
                `[jobcodes] Bootstrap mapped contract ${get_current_route_name(match)} (${match._id}) → QBT jobcode ${jc.name} (${jc.id})`
            );
        }

        if (!more) break;
        page++;
    }
}

async function bootstrap_jobcodes(qbt: qbt_client): Promise<void> {
    console.log("[jobcodes] Running bootstrap: matching QBT jobcodes to contracts by route name...");

    // Load all contracts to search against
    const all_contracts = await mongo.get_conts().find({}).toArray();
    const all_awarded_contracts = all_contracts.filter((c) => {
        return is_awarded(c);
    });

    // We want to match all active jobcodes first, then look at archived ones
    await boostrap_jobcodes_loop(qbt, all_awarded_contracts, true);
    await boostrap_jobcodes_loop(qbt, all_awarded_contracts, false);
    save_jobcode_state({ bootstrap_complete: true });
    console.log("[jobcodes] Bootstrap complete.");
}

async function sync_contract(cont: contract_route_doc, qbt: qbt_client): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_active_qbt_jobcode(cont);
    const cur_rname = get_current_route_name(cont);
    const mapping = await map_col.findOne({
        type: "jobcode",
        our_id: cont._id,
    });

    if (mapping) {
        const jci = await qbt.fetch_jobcode(mapping.qbt_id);
        if (want && (!jci.active || (cont.route_num && jci.name != cont.route_num))) {
            //const update_obj
        }
        else {
            
        }
    }
    else if (want) {
        const created = await qbt.create_jobcode({
            name: cont.route_num ?? cur_rname,
            jobcode_type: "regular",
        });
        const map_obj = create_qbt_object_map_item(
            created.id,
            cont._id,
            "jobcode",
            QBT_ACTIVE,
            new Date(created.last_modified)
        );
        await map_col.insertOne(map_obj);
        console.log(
            `[jobcodes] Created QBT jobcode ${created.name} (${created.id}) for contract  ${cur_rname} (${cont._id})`
        );
    }

    
    // if (want) {
        
    //     if (!mapping) {
    //         const created = await qbt.create_jobcode({
    //             name: cont.route_num ?? cur_rname,
    //             jobcode_type: "regular",
    //         });
    //         const map_obj = create_qbt_object_map_item(
    //             created.id,
    //             cont._id,
    //             "jobcode",
    //             QBT_ACTIVE,
    //             new Date(created.last_modified)
    //         );
    //         await map_col.insertOne(map_obj);
    //         console.log(
    //             `[jobcodes] Created QBT jobcode ${created.name} (${created.id}) for contract  ${cur_rname} (${cont._id})`
    //         );
    //     } else if ((mapping.qbt_status ?? QBT_ACTIVE) !== QBT_ACTIVE) {
    //         await qbt.set_jobcode_active(mapping.qbt_id, true);
    //         await map_col.updateOne({ _id: mapping._id }, { $set: { qbt_status: QBT_ACTIVE } });
    //         console.log(`[jobcodes] Reactivated QBT jobcode ${mapping.qbt_id} for contract ${cont._id}`);
    //     }
    // } else {
    //     if (mapping && (mapping.qbt_status ?? QBT_ACTIVE) !== QBT_ARCHIVED) {
    //         await qbt.set_jobcode_active(mapping.qbt_id, false);
    //         await map_col.updateOne({ _id: mapping._id }, { $set: { qbt_status: QBT_ARCHIVED } });
    //         console.log(`[jobcodes] Archived QBT jobcode ${mapping.qbt_id} for contract ${cont._id}`);
    //     }
    // }

    // Reconcile this jobcode's assignments now that its active state is settled.
    const jc_map = await map_col.findOne({ type: "jobcode", our_id: cont._id });
    if (!jc_map) return;
    if ((jc_map.qbt_status ?? QBT_ACTIVE) !== QBT_ACTIVE) {
        await reconcile_jobcode_assignments(qbt, jc_map.qbt_id, new Set());
        return;
    }

    const hres_ids = [...emp_hres_ids(cont)];
    const desired = new Set<number>();
    if (hres_ids.length) {
        const user_maps = await map_col.find({ type: "user", our_id: { $in: hres_ids } }).toArray();
        for (const um of user_maps) {
            if ((um.qbt_status ?? QBT_ACTIVE) === QBT_ACTIVE) desired.add(um.qbt_id);
        }
    }
    await reconcile_jobcode_assignments(qbt, jc_map.qbt_id, desired);
}

export async function sync_jobcodes(qbt: qbt_client): Promise<void> {
    const state = load_sync_state();

    if (!state.jobcodes.bootstrap_complete) {
        await bootstrap_jobcodes(qbt);
    }

    const since = state.jobcodes.last_synced ?? new Date(0);
    console.log(`[jobcodes] Delta sync since ${since.toISOString()}`);

    const changed = await mongo
        .get_conts()
        .find({ "last_update.on": { $gt: since } })
        .toArray();

    let latest = since;
    for (const cont of changed) {
        try {
            await sync_contract(cont, qbt);
        } catch (err) {
            console.error(`[jobcodes] Error syncing contract ${cont._id}:`, err);
        }
        if (cont.last_update.on > latest) latest = cont.last_update.on;
    }

    if (latest > since) {
        save_jobcode_state({ last_synced: latest });
        console.log(`[jobcodes] Cursor advanced to ${latest.toISOString()}`);
    } else {
        console.log("[jobcodes] No contract changes.");
    }
}
