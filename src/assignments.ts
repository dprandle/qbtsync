import { contract_route_doc } from "./types";
import { qbt_client } from "./qbt_client_interface";

// INVALID_DATETIME sentinel stored by UberMail for un-archived documents
export const INVALID_DATETIME = new Date("0001-01-01T00:00:00.000Z");

// Source_str values of the 7 hardcoded bid roles (mirrors BID_ROLES in croute.cpp).
// A contract is "awarded" when none of these keys exist in assignments.
export const BID_ROLE_KEYS = new Set([
    "AA_Draft_Bid[021422170000UTC]",
    "A_Draft_Bid[021422170000UTC]",
    "A_Draft_Bid_Verified[021422170000UTC]",
    "B_Reviewed_Bid[021422170000UTC]",
    "C_Submitted_Bid[021422170000UTC]",
    "D_Submitted_Bid[021422170000UTC]",
    "E_Submitted_Bid[021422170000UTC]",
]);

// Employee role keys whose linked hresources should receive a jobcode assignment.
export const EMP_ROLE_KEYS = new Set([
    "A_Main_Carrier[021422170000UTC]",
    "B_Sub_Carrier[021422170000UTC]",
]);

export function is_active(archived_on: Date): boolean {
    return archived_on.getTime() <= INVALID_DATETIME.getTime();
}

export function is_awarded(cont: contract_route_doc): boolean {
    return !Object.keys(cont.assignments).some((key) => BID_ROLE_KEYS.has(key));
}

// Collect the hresource ids linked to a contract under any employee role.
export function emp_hres_ids(cont: contract_route_doc): Set<string> {
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

type pair_key = string; // `${user_id}:${jobcode_id}`

function pair(user_id: number, jobcode_id: number): pair_key {
    return `${user_id}:${jobcode_id}`;
}

// Reconcile a single QBT jobcode's assignments against the desired set of active
// QBT user ids. Pass an empty set to remove every assignment for the jobcode.
export async function reconcile_jobcode_assignments(
    qbt: qbt_client,
    jobcode_id: number,
    desired_user_ids: Set<number>
): Promise<void> {
    const actual = new Map<pair_key, number>(); // pair_key → assignment id
    let page = 1;
    while (true) {
        const { assignments, more } = await qbt.fetch_jobcode_assignments({ jobcode_ids: [jobcode_id], page });
        for (const a of assignments) {
            if (a.active) actual.set(pair(a.user_id, a.jobcode_id), a.id);
        }
        if (!more) break;
        page++;
    }

    for (const user_id of desired_user_ids) {
        if (!actual.has(pair(user_id, jobcode_id))) {
            try {
                await qbt.create_jobcode_assignment(user_id, jobcode_id);
            } catch (err) {
                console.error(`[assignments] Failed to create assignment ${user_id}:${jobcode_id}:`, err);
            }
        }
    }

    for (const [key, asgn_id] of actual) {
        const user_id = Number(key.split(":")[0]);
        if (!desired_user_ids.has(user_id)) {
            try {
                await qbt.delete_jobcode_assignment(asgn_id);
            } catch (err) {
                console.error(`[assignments] Failed to delete assignment ${key}:`, err);
            }
        }
    }
}

// Reconcile a single QBT user's assignments against the desired set of active QBT
// jobcode ids. Pass an empty set to remove every assignment for the user.
export async function reconcile_user_assignments(
    qbt: qbt_client,
    user_id: number,
    desired_jobcode_ids: Set<number>
): Promise<void> {
    const actual = new Map<pair_key, number>(); // pair_key → assignment id
    let page = 1;
    while (true) {
        const { assignments, more } = await qbt.fetch_jobcode_assignments({ user_ids: [user_id], page });
        for (const a of assignments) {
            if (a.active) actual.set(pair(a.user_id, a.jobcode_id), a.id);
        }
        if (!more) break;
        page++;
    }

    for (const jobcode_id of desired_jobcode_ids) {
        if (!actual.has(pair(user_id, jobcode_id))) {
            try {
                await qbt.create_jobcode_assignment(user_id, jobcode_id);
            } catch (err) {
                console.error(`[assignments] Failed to create assignment ${user_id}:${jobcode_id}:`, err);
            }
        }
    }

    for (const [key, asgn_id] of actual) {
        const jobcode_id = Number(key.split(":")[1]);
        if (!desired_jobcode_ids.has(jobcode_id)) {
            try {
                await qbt.delete_jobcode_assignment(asgn_id);
            } catch (err) {
                console.error(`[assignments] Failed to delete assignment ${key}:`, err);
            }
        }
    }
}
