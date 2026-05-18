// QuickBooks Time API types

export type qbt_timesheet = {
    id: number;
    user_id: number;
    jobcode_id: number;
    start: string;       // ISO 8601
    end: string;         // ISO 8601
    duration: number;    // seconds
    date: string;        // YYYY-MM-DD
    type: "regular" | "pto";
    active: boolean;
    locked: number;
    notes: string;
    last_modified: string; // ISO 8601
    tz: string;
    customfields: Record<string, string>;
};

export type qbt_timesheets_response = {
    results: {
        timesheets: Record<string, qbt_timesheet>;
    };
    more: boolean;
    supplemental_data?: {
        users?: Record<string, unknown>;
        jobcodes?: Record<string, unknown>;
    };
};

// MongoDB document types

export type qbt_object_type = "timesheet" | "user" | "jobcode";

export type qbt_object_map = {
    qbt_id: number;
    our_id: string;
    type: qbt_object_type;
    qbt_modified: Date;
};

export type time_record = {
    _id: string;
    hrid: string;       // hresource id
    cont_id: string;    // contract id
    notes: string;
    start: Date;
    end: Date;
    date: Date;
    created_at: Date;
    updated_at: Date;
};

export type sync_state = {
    _id: string;            // fixed key, e.g. "qbt_sync"
    full_import_complete: boolean;
    // Date of last timesheet last_modified seen — used as modified_since on next poll
    last_synced: Date | null;
    // During full import, tracks the last page completed so we can resume on crash
    full_import_page: number;
};
