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

// One QBT user's active jobcode assignments as jobcode_id -> assignment id.
async function fetch_active_assignments_for_user(qbt: qbt_client, user_id: number): Promise<Map<number, number>> {
    const actual = new Map<number, number>();
    let page = 1;
    while (true) {
        const { items: assignments, more } = await qbt.fetch_jobcode_assignments({ user_ids: [user_id], page });
        for (const a of assignments) {
            if (a.active) actual.set(a.jobcode_id, a.id);
        }
        if (!more) break;
        page++;
    }
    return actual;
}

// Prefetch active assignments for many users in one batched pass. QBT's
// jobcode_assignments endpoint accepts user_ids (plural), so each page covers up
// to 100 users at once — collapsing what was one paginated GET *per user* into
// ceil(total_assignments / 100) reads, the dominant cost of the per-hres path.
// Returns user_id -> (jobcode_id -> assignment id); every requested user is
// present (empty map when it has none) so callers never need a fallback fetch.
export async function prefetch_active_assignments_by_user(
    qbt: qbt_client,
    user_ids: number[]
): Promise<Map<number, Map<number, number>>> {
    const out = new Map<number, Map<number, number>>();
    for (const id of user_ids) out.set(id, new Map());
    // 100 = QBT's page cap; a chunk of <=100 user_ids still spans multiple pages
    // when those users have many assignments between them, so paginate each chunk.
    for (let i = 0; i < user_ids.length; i += 100) {
        const chunk = user_ids.slice(i, i + 100);
        let page = 1;
        while (true) {
            const { items, more } = await qbt.fetch_jobcode_assignments({ user_ids: chunk, page });
            for (const a of items) {
                if (a.active) out.get(a.user_id)?.set(a.jobcode_id, a.id);
            }
            if (!more) break;
            page++;
        }
    }
    return out;
}

// Reconcile a single QBT user's assignments against the desired set of active QBT
// jobcode ids. Pass an empty set to remove every assignment for the user. `actual`
// is the user's current active assignments (jobcode_id -> assignment id); the delta
// loop passes a prefetched map to avoid a per-user GET, and it's fetched for this
// one user when omitted.
export async function reconcile_jc_assignments_by_user(
    qbt: qbt_client,
    user_id: number,
    desired_jobcode_ids: Set<number>,
    actual?: Map<number, number>
): Promise<void> {
    const current = actual ?? (await fetch_active_assignments_for_user(qbt, user_id));

    let create_ops = 0;
    let delete_ops = 0;
    for (const jobcode_id of desired_jobcode_ids) {
        if (!current.has(jobcode_id)) {
            try {
                await qbt.create_jobcode_assignment(user_id, jobcode_id);
                ++create_ops;
                ilog(`[jca] Created jc assignment ${user_id}:${jobcode_id}`);
            } catch (err) {
                elog(`[jca] Failed to create assignment ${user_id}:${jobcode_id}:`, err);
            }
        }
    }

    for (const [jobcode_id, asgn_id] of current) {
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
