import { randomUUID } from "crypto";
import { save_jobcode_state, load_sync_state } from "./sync_state";
import { contracts_col, qbt_object_map_col } from "./db";
import { contract_route_doc } from "./types";
import { QbtClient } from "./qbt_client_interface";

// INVALID_DATETIME sentinel stored by UberMail for un-archived documents
const INVALID_DATETIME = new Date("0001-01-01T00:00:00.000Z");

// Source_str values of the 7 hardcoded bid roles (mirrors BID_ROLES in croute.cpp).
// A contract is "awarded" when none of these keys exist in assignments.
const BID_ROLE_KEYS = new Set([
    "AA_Draft_Bid[021422170000UTC]",
    "A_Draft_Bid[021422170000UTC]",
    "A_Draft_Bid_Verified[021422170000UTC]",
    "B_Reviewed_Bid[021422170000UTC]",
    "C_Submitted_Bid[021422170000UTC]",
    "D_Submitted_Bid[021422170000UTC]",
    "E_Submitted_Bid[021422170000UTC]",
]);

function is_awarded(cont: contract_route_doc): boolean {
    return !Object.keys(cont.assignments).some((key) => BID_ROLE_KEYS.has(key));
}

function should_have_qbt_jobcode(cont: contract_route_doc): boolean {
    const is_active = cont.archived_info.on.getTime() <= INVALID_DATETIME.getTime();
    return is_active && is_awarded(cont);
}

async function bootstrap_jobcodes(qbt: QbtClient): Promise<void> {
    console.log("[jobcodes] Running bootstrap: matching QBT jobcodes to contracts by route name...");
    const map_col = qbt_object_map_col();

    // Load all contracts to search against
    const all_contracts = await contracts_col().find({}).toArray();

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

async function sync_contract(cont: contract_route_doc, qbt: QbtClient): Promise<void> {
    const map_col = qbt_object_map_col();
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
                qbt_modified: new Date(created.last_modified),
                our_updated_at: null,
            });
            console.log(`[jobcodes] Created QBT jobcode ${created.id} for contract ${cont._id} (${cont.route_num})`);
        } else {
            // Ensure the jobcode is active — fetch to check current state
            const { jobcodes } = await qbt.fetch_jobcodes({ page: 1 });
            const jc = jobcodes.find((j) => j.id === mapping.qbt_id);
            if (jc && !jc.active) {
                await qbt.set_jobcode_active(mapping.qbt_id, true);
                console.log(`[jobcodes] Reactivated QBT jobcode ${mapping.qbt_id} for contract ${cont._id}`);
            }
        }
    } else {
        if (mapping) {
            await qbt.set_jobcode_active(mapping.qbt_id, false);
            console.log(`[jobcodes] Archived QBT jobcode ${mapping.qbt_id} for contract ${cont._id}`);
        }
    }
}

export async function sync_jobcodes(qbt: QbtClient): Promise<void> {
    const state = load_sync_state();

    if (!state.jobcodes.bootstrap_complete) {
        await bootstrap_jobcodes(qbt);
    }

    const since = state.jobcodes.last_synced ?? new Date(0);
    console.log(`[jobcodes] Delta sync since ${since.toISOString()}`);

    const changed = await contracts_col()
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
