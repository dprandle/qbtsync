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
};

export function create_qbt_object_map_item(
    qbt_id: number,
    our_id: string,
    type: qbt_object_type,
    qbt_modified: Date
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
    };
}
