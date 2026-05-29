import { contracts_col, hresources_col, qbt_object_map_col } from "./db";
import { contract_route_doc } from "./types";
import { QbtClient } from "./qbt_client_interface";

const INVALID_DATETIME = new Date("0001-01-01T00:00:00.000Z");

const BID_ROLE_KEYS = new Set([
    "AA_Draft_Bid[021422170000UTC]",
    "A_Draft_Bid[021422170000UTC]",
    "A_Draft_Bid_Verified[021422170000UTC]",
    "B_Reviewed_Bid[021422170000UTC]",
    "C_Submitted_Bid[021422170000UTC]",
    "D_Submitted_Bid[021422170000UTC]",
    "E_Submitted_Bid[021422170000UTC]",
]);

const EMP_ROLE_KEYS = new Set([
    "A_Main_Carrier[021422170000UTC]",
    "B_Sub_Carrier[021422170000UTC]",
]);

const TIME_TRACKING_APP = 1;

function is_active(archived_on: Date): boolean {
    return archived_on.getTime() <= INVALID_DATETIME.getTime();
}

function is_awarded(cont: contract_route_doc): boolean {
    return !Object.keys(cont.assignments).some((key) => BID_ROLE_KEYS.has(key));
}

type pair_key = string; // `${qbt_user_id}:${qbt_jobcode_id}`

function pair(user_id: number, jobcode_id: number): pair_key {
    return `${user_id}:${jobcode_id}`;
}

export async function sync_assignments(qbt: QbtClient): Promise<void> {
    console.log("[assignments] Reconciling jobcode assignments...");

    const map_col = qbt_object_map_col();

    // Build lookup maps from our IDs to QBT IDs
    const user_mappings = await map_col.find({ type: "user" }).toArray();
    const jobcode_mappings = await map_col.find({ type: "jobcode" }).toArray();

    const our_to_qbt_user = new Map<string, number>(user_mappings.map((m) => [m.our_id, m.qbt_id]));
    const our_to_qbt_jobcode = new Map<string, number>(jobcode_mappings.map((m) => [m.our_id, m.qbt_id]));
    const jobcode_contract_ids = new Set(jobcode_mappings.map((m) => m.our_id));

    // Build the desired set of (qbt_user_id, qbt_jobcode_id) pairs
    const desired = new Map<pair_key, { user_id: number; jobcode_id: number }>();

    // Only examine active+awarded contracts that have a QBT jobcode mapping
    const contracts = await contracts_col()
        .find({ _id: { $in: Array.from(jobcode_contract_ids) } })
        .toArray();

    for (const cont of contracts) {
        if (!is_active(cont.archived_info.on) || !is_awarded(cont)) continue;

        const qbt_jobcode_id = our_to_qbt_jobcode.get(cont._id);
        if (!qbt_jobcode_id) continue;

        // Collect hres_ids linked under employee roles
        const hres_ids = new Set<string>();
        for (const [role_key, links] of Object.entries(cont.assignments)) {
            if (!EMP_ROLE_KEYS.has(role_key)) continue;
            for (const link of links) {
                const src = link.emp_id?.source_str;
                if (src) hres_ids.add(src);
            }
        }

        // Filter: only hres_ids that have TIME_TRACKING_APP flag and a QBT user mapping
        for (const hres_id of hres_ids) {
            const qbt_user_id = our_to_qbt_user.get(hres_id);
            if (!qbt_user_id) continue;

            // Check TIME_TRACKING_APP flag
            const hres = await hresources_col().findOne({ _id: hres_id }, { projection: { tt_flags: 1 } });
            if (!hres || (hres.tt_flags & TIME_TRACKING_APP) === 0) continue;

            desired.set(pair(qbt_user_id, qbt_jobcode_id), { user_id: qbt_user_id, jobcode_id: qbt_jobcode_id });
        }
    }

    // Fetch all current QBT jobcode assignments
    const actual = new Map<pair_key, number>(); // pair_key → qbt assignment id
    let page = 1;
    while (true) {
        const { assignments, more } = await qbt.fetch_jobcode_assignments({ page });
        for (const a of assignments) {
            if (a.active) {
                actual.set(pair(a.user_id, a.jobcode_id), a.id);
            }
        }
        if (!more) break;
        page++;
    }

    // Add missing assignments
    let added = 0;
    let removed = 0;
    for (const [key, { user_id, jobcode_id }] of desired) {
        if (!actual.has(key)) {
            try {
                await qbt.create_jobcode_assignment(user_id, jobcode_id);
                added++;
            } catch (err) {
                console.error(`[assignments] Failed to create assignment ${key}:`, err);
            }
        }
    }

    // Remove extra assignments
    for (const [key, asgn_id] of actual) {
        if (!desired.has(key)) {
            try {
                await qbt.delete_jobcode_assignment(asgn_id);
                removed++;
            } catch (err) {
                console.error(`[assignments] Failed to delete assignment ${key}:`, err);
            }
        }
    }

    console.log(`[assignments] Done. Added: ${added}, removed: ${removed}.`);
}
