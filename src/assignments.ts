import { contract_route_doc } from "./sync_jobcodes";
import { qbt_client } from "./qbt_client_interface";

const BID_ROLE_KEYS = new Set([
    "AA_Draft_Bid[021422170000UTC]",
    "A_Draft_Bid[021422170000UTC]",
    "A_Draft_Bid_Verified[021422170000UTC]",
    "B_Reviewed_Bid[021422170000UTC]",
    "C_Submitted_Bid[021422170000UTC]",
    "D_Submitted_Bid[021422170000UTC]",
    "E_Submitted_Bid[021422170000UTC]",
]);

// Employee role keys whose linked hresources should receive a jobcode assignment.
export const EMP_ACTIVE_ROLE_KEYS = new Set(["A_Main_Carrier[021422170000UTC]", "B_Sub_Carrier[021422170000UTC]"]);

// Broader set of roles that mark an hresource as an employee or manager (vs. a subcontractor).
export const EMP_MGR_ROLE_KEYS = new Set([
    ...EMP_ACTIVE_ROLE_KEYS,
    "C_Previous_Carrier[021422170000UTC]",
    "B_West_Manager[021422170000UTC]",
    "C_South_Manager[021422170000UTC]",
    "D_East_Manager[021422170000UTC]",
]);

export function is_awarded(cont: contract_route_doc): boolean {
    return !Object.keys(cont.assignments).some((key) => BID_ROLE_KEYS.has(key));
}

// Reconcile a single QBT jobcode's assignments against the desired set of active
// QBT user ids. Pass an empty set to remove every assignment for the jobcode.
export async function reconcile_jc_assignments_by_jobcode(
    qbt: qbt_client,
    jobcode_id: number,
    desired_user_ids: Set<number>
): Promise<void> {
    const actual = new Map<number, number>(); // user_id → assignment id
    let page = 1;
    while (true) {
        const { items: assignments, more } = await qbt.fetch_jobcode_assignments({ jobcode_id, page });
        for (const a of assignments) {
            if (a.active) actual.set(a.user_id, a.id);
        }
        if (!more) break;
        page++;
    }
    
    let create_ops = 0;
    let delete_ops = 0;
    for (const user_id of desired_user_ids) {
        if (!actual.has(user_id)) {
            try {
                await qbt.create_jobcode_assignment(user_id, jobcode_id);
                ilog(`[jca] Created jc assignment for ${user_id}:${jobcode_id}`);
                ++create_ops;
            } catch (err) {
                elog(`[jca] Failed to create jc assignment ${user_id}:${jobcode_id}:`, err);
            }
        }
    }

    for (const [user_id, asgn_id] of actual) {
        if (!desired_user_ids.has(user_id)) {
            try {
                await qbt.delete_jobcode_assignment(asgn_id);
                ilog(`[jca] Deleted jc assignment ${user_id}:${jobcode_id}`);
                ++delete_ops;
            } catch (err) {
                elog(`[jca] Failed to delete jc assignment ${user_id}:${jobcode_id}:`, err);
            }
        }
    }
    const txt = create_ops > 0 || delete_ops > 0 ? `created:${create_ops} deleted:${delete_ops}` : "No assignment changes";
    ilog(`[jca] Finished sync - ${txt}`);
}

// Reconcile a single QBT user's assignments against the desired set of active QBT
// jobcode ids. Pass an empty set to remove every assignment for the user.
export async function reconcile_jc_assignments_by_user(
    qbt: qbt_client,
    user_id: number,
    desired_jobcode_ids: Set<number>
): Promise<void> {
    const actual = new Map<number, number>(); // jobcode_id → assignment id
    let page = 1;
    while (true) {
        const { items: assignments, more } = await qbt.fetch_jobcode_assignments({ user_ids: [user_id], page });
        for (const a of assignments) {
            if (a.active) actual.set(a.jobcode_id, a.id);
        }
        if (!more) break;
        page++;
    }

    let create_ops = 0;
    let delete_ops = 0;
    for (const jobcode_id of desired_jobcode_ids) {
        if (!actual.has(jobcode_id)) {
            try {
                await qbt.create_jobcode_assignment(user_id, jobcode_id);
                ++create_ops;
                ilog(`[jca] Created jc assignment ${user_id}:${jobcode_id}`);
            } catch (err) {
                elog(`[jca] Failed to create assignment ${user_id}:${jobcode_id}:`, err);
            }
        }
    }

    for (const [jobcode_id, asgn_id] of actual) {
        if (!desired_jobcode_ids.has(jobcode_id)) {
            try {
                await qbt.delete_jobcode_assignment(asgn_id);
                ilog(`[jca] Delete jc assignment ${user_id}:${jobcode_id}`);
                ++delete_ops;
            } catch (err) {
                elog(`[jca] Failed to delete assignment ${user_id}:${jobcode_id}:`, err);
            }
        }
    }
    const txt = create_ops > 0 || delete_ops > 0 ? `created:${create_ops} deleted:${delete_ops}` : "No assignment changes";
    ilog(`[jca] Finished sync - ${txt}`);
}
