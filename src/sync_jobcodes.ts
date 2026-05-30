import { randomUUID } from "crypto";
import { save_jobcode_state, load_sync_state } from "./sync_state";
import { get_cont_collection, get_qbt_map_collection } from "./db";
import { contract_route_doc, QBT_ACTIVE, QBT_ARCHIVED } from "./types";
import { qbt_client } from "./qbt_client_interface";
import {
    is_active,
    is_awarded,
    emp_hres_ids,
    reconcile_jobcode_assignments,
} from "./assignments";

function should_have_qbt_jobcode(cont: contract_route_doc): boolean {
    return is_active(cont.archived_info.on) && is_awarded(cont);
}

async function bootstrap_jobcodes(qbt: qbt_client): Promise<void> {
    console.log("[jobcodes] Running bootstrap: matching QBT jobcodes to contracts by route name...");
    const map_col = get_qbt_map_collection();

    // Load all contracts to search against
    const all_contracts = await get_cont_collection().find({}).toArray();

    let page = 1;
    while (true) {
        const { jobcodes, more } = await qbt.fetch_jobcodes({ page });

        for (const jc of jobcodes) {
            const existing = await map_col.findOne({ type: "jobcode", qbt_id: jc.id });
            if (existing) continue;

            // Match: find a contract whose route_num appears as a whole word in the jobcode name
            // Mirrors find_first_contract_from_jobcode logic in croute.cpp:1723
            const match = all_contracts.find((c) => {
                if (!is_awarded(c)) return false;
                const escaped = c.route_num.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
                return new RegExp(`(?:^|\\s)${escaped}(?:\\s|$)`).test(jc.name);
            });
            if (!match) continue;

            const already_mapped = await map_col.findOne({ type: "jobcode", our_id: match._id });
            if (already_mapped) continue;

            await map_col.insertOne({
                _id: randomUUID(),
                qbt_id: jc.id,
                our_id: match._id,
                type: "jobcode",
                qbt_status: jc.active ? QBT_ACTIVE : QBT_ARCHIVED,
                qbt_modified: new Date(jc.last_modified),
                our_updated_at: null,
            });
            console.log(`[jobcodes] Bootstrap mapped contract ${match._id} (${match.route_num}) → QBT jobcode ${jc.id}`);
        }

        if (!more) break;
        page++;
    }

    await save_jobcode_state({ bootstrap_complete: true });
    console.log("[jobcodes] Bootstrap complete.");
}

async function sync_contract(cont: contract_route_doc, qbt: qbt_client): Promise<void> {
    const map_col = get_qbt_map_collection();
    const want = should_have_qbt_jobcode(cont);
    const mapping = await map_col.findOne({ type: "jobcode", our_id: cont._id });

    if (want) {
        if (!mapping) {
            const created = await qbt.create_jobcode({ name: cont.route_num, jobcode_type: "regular" });
            await map_col.insertOne({
                _id: randomUUID(),
                qbt_id: created.id,
                our_id: cont._id,
                type: "jobcode",
                qbt_status: QBT_ACTIVE,
                qbt_modified: new Date(created.last_modified),
                our_updated_at: null,
            });
            console.log(`[jobcodes] Created QBT jobcode ${created.id} for contract ${cont._id} (${cont.route_num})`);
        } else if ((mapping.qbt_status ?? QBT_ACTIVE) !== QBT_ACTIVE) {
            await qbt.set_jobcode_active(mapping.qbt_id, true);
            await map_col.updateOne({ _id: mapping._id }, { $set: { qbt_status: QBT_ACTIVE } });
            console.log(`[jobcodes] Reactivated QBT jobcode ${mapping.qbt_id} for contract ${cont._id}`);
        }
    } else {
        if (mapping && (mapping.qbt_status ?? QBT_ACTIVE) !== QBT_ARCHIVED) {
            await qbt.set_jobcode_active(mapping.qbt_id, false);
            await map_col.updateOne({ _id: mapping._id }, { $set: { qbt_status: QBT_ARCHIVED } });
            console.log(`[jobcodes] Archived QBT jobcode ${mapping.qbt_id} for contract ${cont._id}`);
        }
    }

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

    const changed = await get_cont_collection()
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
        await save_jobcode_state({ last_synced: latest });
        console.log(`[jobcodes] Cursor advanced to ${latest.toISOString()}`);
    } else {
        console.log("[jobcodes] No contract changes.");
    }
}
