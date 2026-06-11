import { randomUUID } from "crypto";
import { type change_info, make_ci_now, make_ci_not_archived, INVALID_DATETIME } from "./uobj_common";
export type qbt_object_type = "timesheet" | "user" | "jobcode";

export type qbt_object_map = {
    _id: string;
    custom_params: Record<string, string>;
    archived_info: change_info;
    last_update: change_info;
    created: change_info;
    schema_version: number;
    qbt_id: number;
    our_id: string;
    type: qbt_object_type;
    qbt_modified: Date;
    // Multiple QBT objects can legitimately link to one of our records (historical
    // duplicate users/jobcodes that pre-date the sync — old timesheets are tied to
    // them and must stay resolvable inbound). link_id orders those links per our_id,
    // assigned densely from 0 at bootstrap. The lowest link_id is the *primary*: the
    // one canonical object outbound writes (new timesheets, updates, assignments,
    // invites) use. (qbt_id stays globally unique per type — each QBT object maps to
    // exactly one of ours; it's only our_id that may now repeat.)
    link_id: number;
};

export function create_qbt_object_map_item(
    qbt_id: number,
    our_id: string,
    type: qbt_object_type,
    qbt_modified: Date,
    link_id = 0
): qbt_object_map {
    const now_ci = make_ci_now();
    return {
        _id: randomUUID(),
        custom_params: {},
        archived_info: make_ci_not_archived(),
        last_update: now_ci,
        created: now_ci,
        schema_version: 1,
        qbt_id,
        our_id,
        type,
        qbt_modified,
        link_id,
    };
}

// Pick the primary (lowest link_id) map per our_id from a flat list — e.g. the
// result of a `{ our_id: { $in: [...] } }` query that may now return several maps
// per our_id. Outbound code keys off this so it always writes the one canonical
// QBT object. Lowest (not ==0) keeps this correct if the 0-link object is later
// hard-deleted and removed by cleanup; legacy docs without link_id read as 0.
export function primary_by_our_id(maps: qbt_object_map[]): Map<string, qbt_object_map> {
    const out = new Map<string, qbt_object_map>();
    for (const m of maps) {
        const cur = out.get(m.our_id);
        if (!cur || (m.link_id ?? 0) < (cur.link_id ?? 0)) out.set(m.our_id, m);
    }
    return out;
}
