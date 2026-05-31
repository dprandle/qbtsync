import { randomUUID } from "crypto";
import { change_info, INVALID_DATETIME } from "./uobj_common";
export type qbt_object_type = "timesheet" | "user" | "jobcode";

// Mirrors the QBT object's active flag so reconciliation can read active/archived
// state from the map without paging QBT. 0 = archived, 1 = active.
export type qbt_status = 0 | 1;
export const QBT_ARCHIVED: qbt_status = 0;
export const QBT_ACTIVE: qbt_status = 1;
export const QBT_UPDATE_BY = "qbtsync";

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
    qbt_status: qbt_status;
    qbt_modified: Date;
};

export function create_qbt_object_map_item(
    qbt_id: number,
    our_id: string,
    type: qbt_object_type,
    qbt_status: qbt_status,
    qbt_modified: Date
): qbt_object_map {
    const now = new Date();
    return {
        _id: randomUUID(),
        custom_params: {},
        archived_info: { by: "", on: INVALID_DATETIME },
        last_update: { by: QBT_UPDATE_BY, on: now },
        created: { by: QBT_UPDATE_BY, on: now },
        schema_version: 1,
        qbt_id,
        our_id,
        type,
        qbt_status,
        qbt_modified,
    };
}
