export type fetch_items_result<T> = {
    items: T[];
    more: boolean;
};

// QBT caps responses at 100 items per page, and a by-ids request returns at
// most one item per id — so a chunk of <=100 ids always fits in a single page.
// Iterate chunks; no need to walk pagination within each one.
const FETCH_BATCH_SIZE = 100;

export async function fetch_all_by_ids<T>(
    ids: number[],
    fetch_chunk: (chunk: number[]) => Promise<fetch_items_result<T>>
): Promise<T[]> {
    const out: T[] = [];
    for (let i = 0; i < ids.length; i += FETCH_BATCH_SIZE) {
        const { items } = await fetch_chunk(ids.slice(i, i + FETCH_BATCH_SIZE));
        out.push(...items);
    }
    return out;
}

export type active_param = "yes" | "no" | "both";

// Free-form object filter used by the introspection query_* methods. Each entry is
// a QBT filter: for the live client it becomes a query param (arrays are joined into
// the comma-separated form QBT expects); for the mock it's applied as a Mongo filter.
export type qbt_query_filter = Record<string, unknown>;

export type fetch_timesheets_opts = {
    modified_since?: Date;
    page?: number;
    ids?: number[];
};

export type fetch_timesheets_result = fetch_items_result<qbt_timesheet>;

export type fetch_users_opts = {
    active: active_param;
    modified_since?: Date;
    page?: number;
    ids?: number[];
};

export type fetch_users_result = fetch_items_result<qbt_user>;

export type fetch_jobcodes_opts = {
    active: active_param;
    modified_since?: Date;
    page?: number;
    ids?: number[];
};

export type fetch_jobcodes_result = fetch_items_result<qbt_jobcode>;

export type fetch_assignments_opts = {
    modified_since?: Date;
    page?: number;
    // QBT's jobcode_assignments endpoint only filters by a single jobcode_id (not
    // a list) — and by user_ids (a list). Keep these shapes matched to the API.
    jobcode_id?: number;
    user_ids?: number[];
    ids?: number[];
};

export type fetch_assignments_result = fetch_items_result<qbt_jobcode_assignment>;

// timesheets_deleted is a read-only feed of removed timesheets. modified_since is
// required by QBT (deletions are only addressable by when they happened), and we only
// ever need the ids — enough to drop the matching rows from the mock store.
export type fetch_deleted_timesheets_opts = {
    modified_since: Date;
    page?: number;
};

export type fetch_deleted_timesheets_result = {
    ids: number[];
    more: boolean;
};

export type qbt_contact_method = "sms" | "email";

// Per the QBT invitations API, contact_method is always required, and exactly
// one of user_id (invite an existing user) or contact_info (the email/phone to
// send the invite to) must be supplied — they're mutually exclusive.
export type create_invitation_opts =
    | { contact_method: qbt_contact_method; user_id: number }
    | { contact_method: qbt_contact_method; contact_info: string };

// QuickBooks Time API types
export type qbt_user = {
    id: number;
    username: string;
    email: string;
    first_name: string;
    last_name: string;
    mobile_number: string;
    active: boolean;
    employee_role: string;
    last_modified: string; // ISO 8601
};

export type qbt_users_response = {
    results: {
        users: Record<string, qbt_user & qbt_item_status>;
    };
    more: boolean;
};

export type qbt_timesheet = {
    id: number;
    user_id: number;
    jobcode_id: number;
    notes: string;
    start: string; // ISO 8601
    end: string; // ISO 8601
    date: string; // YYYY-MM-DD
    location: string;
    on_the_clock: boolean;
    last_modified: string; // ISO 8601    
};

export type timesheet_write_data = Omit<qbt_timesheet, "id" | "last_modified">;

// Batch write endpoints (PUT/POST) return HTTP 200 even when an individual item
// fails; the per-item outcome carries these status fields. Successful items report
// _status_code 200/201; failures omit the real object fields and only set these.
export type qbt_item_status = {
    _status_code?: number;
    _status_message?: string;
    _status_extra?: string;
};

export type qbt_timesheets_response = {
    results: {
        timesheets: Record<string, qbt_timesheet & qbt_item_status>;
    };
    more: boolean;
    supplemental_data?: {
        users?: Record<string, unknown>;
        jobcodes?: Record<string, unknown>;
    };
};

// /timesheets_deleted returns the removed timesheets keyed by id; we only read the id.
export type qbt_timesheets_deleted_response = {
    results: {
        timesheets_deleted: Record<string, { id: number }>;
    };
    more: boolean;
};

export type qbt_jobcode = {
    id: number;
    active: boolean;
    name: string;
    last_modified: string; // ISO 8601
    created: string; // ISO 8601
};

export type qbt_jobcodes_response = {
    results: {
        jobcodes: Record<string, qbt_jobcode & qbt_item_status>;
    };
    more: boolean;
};

export type qbt_jobcode_assignment = {
    id: number;
    user_id: number;
    jobcode_id: number;
    active: boolean;
    last_modified: string; // ISO 8601
};

export type qbt_jobcode_assignments_response = {
    results: {
        jobcode_assignments: Record<string, qbt_jobcode_assignment & qbt_item_status>;
    };
    more: boolean;
};

// Per-invite outcome, keyed by request-array index in the response.
export type qbt_invite_result = {
    _status_code: number;
    _status_message: string;
};

export type qbt_invitations_response = {
    results: {
        invites: Record<string, qbt_invite_result>;
    };
};

// Mock-storage shapes: the wire-side `id: number` becomes Mongo's `_id: number`
// so the mock collections can be typed natively without casts.
export type mock_qbt_user = Omit<qbt_user, "id"> & { _id: number };
export type mock_qbt_jobcode = Omit<qbt_jobcode, "id"> & { _id: number };
export type mock_qbt_jobcode_assignment = Omit<qbt_jobcode_assignment, "id"> & { _id: number };
export type mock_qbt_timesheet = Omit<qbt_timesheet, "id"> & { _id: number };

export interface qbt_client {
    // Timesheets
    fetch_timesheets(opts: fetch_timesheets_opts): Promise<fetch_timesheets_result>;
    fetch_timesheet(id: number): Promise<qbt_timesheet>;
    create_timesheet(data: timesheet_write_data): Promise<qbt_timesheet>;
    update_timesheet(id: number, data: Partial<timesheet_write_data>): Promise<qbt_timesheet>;
    // QBT's delete endpoint is multi-id by default; delete_timesheets is the real
    // shape and delete_timesheet is the single-id convenience (mirrors fetch_*).
    delete_timesheets(ids: number[]): Promise<void>;
    delete_timesheet(id: number): Promise<void>;
    // Read-only feed of removed timesheets; returns the deleted ids modified_since.
    fetch_deleted_timesheets(opts: fetch_deleted_timesheets_opts): Promise<fetch_deleted_timesheets_result>;

    // Users
    fetch_users(opts: fetch_users_opts): Promise<fetch_users_result>;
    fetch_user(id: number): Promise<qbt_user>;
    create_user(data: {
        username: string;
        email: string;
        first_name: string;
        last_name: string;
        mobile_number: string;
    }): Promise<qbt_user>;
    update_user(id: number, data: Partial<qbt_user>): Promise<qbt_user>;

    // Jobcodes
    fetch_jobcodes(opts: fetch_jobcodes_opts): Promise<fetch_jobcodes_result>;
    fetch_jobcode(id: number): Promise<qbt_jobcode>;
    create_jobcode(data: { name: string; jobcode_type: string }): Promise<qbt_jobcode>;
    update_jobcode(id: number, data: Partial<qbt_jobcode>): Promise<qbt_jobcode>;

    // Jobcode Assignments
    fetch_jobcode_assignments(opts: fetch_assignments_opts): Promise<fetch_assignments_result>;
    fetch_jobcode_assignment(id: number): Promise<qbt_jobcode_assignment>;
    create_jobcode_assignment(user_id: number, jobcode_id: number): Promise<qbt_jobcode_assignment>;
    delete_jobcode_assignment(id: number): Promise<void>;

    // Invitations
    create_invitation(opts: create_invitation_opts): Promise<qbt_invite_result>;

    // Object-filter queries (dev/introspection). The filter is a free-form object,
    // kind of like a Mongo filter: the live client turns it into QBT query params,
    // the mock applies it as a Mongo filter. Each returns the matched items for the
    // single page the underlying request yields.
    query_timesheets(filter: qbt_query_filter): Promise<qbt_timesheet[]>;
    query_users(filter: qbt_query_filter): Promise<qbt_user[]>;
    query_jobcodes(filter: qbt_query_filter): Promise<qbt_jobcode[]>;
    query_jobcode_assignments(filter: qbt_query_filter): Promise<qbt_jobcode_assignment[]>;
}
