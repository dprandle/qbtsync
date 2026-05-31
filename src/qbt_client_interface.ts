export type fetch_timesheets_opts = {
    modified_since?: Date;
    page?: number;
};

export type fetch_timesheets_result = {
    timesheets: qbt_timesheet[];
    more: boolean;
};

export type fetch_users_opts = {
    modified_since?: Date;
    page?: number;
};

export type fetch_users_result = {
    users: qbt_user[];
    more: boolean;
};

export type fetch_jobcodes_opts = {
    modified_since?: Date;
    page?: number;
    active?: boolean;
};

export type fetch_jobcodes_result = {
    jobcodes: qbt_jobcode[];
    more: boolean;
};

export type fetch_assignments_opts = {
    page?: number;
    jobcode_ids?: number[];
    user_ids?: number[];
};

export type fetch_assignments_result = {
    assignments: qbt_jobcode_assignment[];
    more: boolean;
};

export type timesheet_write_data = {
    user_id: number;
    jobcode_id: number;
    start: string;
    end: string;
    date: string;
    type: string;
    notes: string;
};

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
        users: Record<string, qbt_user>;
    };
    more: boolean;
};

export type qbt_timesheet = {
    id: number;
    user_id: number;
    jobcode_id: number;
    start: string; // ISO 8601
    end: string; // ISO 8601
    duration: number; // seconds
    date: string; // YYYY-MM-DD
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

export type qbt_jobcode = {
    id: number;
    parent_id: number;
    name: string;
    active: boolean;
    last_modified: string; // ISO 8601
};

export type qbt_jobcodes_response = {
    results: {
        jobcodes: Record<string, qbt_jobcode>;
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
        jobcode_assignments: Record<string, qbt_jobcode_assignment>;
    };
    more: boolean;
};

export interface qbt_client {
    // Timesheets
    fetch_timesheets(opts: fetch_timesheets_opts): Promise<fetch_timesheets_result>;
    create_timesheet(data: timesheet_write_data): Promise<qbt_timesheet>;
    update_timesheet(id: number, data: Partial<timesheet_write_data>): Promise<qbt_timesheet>;

    // Users
    fetch_users(opts: fetch_users_opts): Promise<fetch_users_result>;
    create_user(data: {
        username: string;
        email: string;
        first_name: string;
        last_name: string;
        mobile_number: string;
    }): Promise<qbt_user>;
    set_user_active(id: number, active: boolean): Promise<void>;

    // Jobcodes
    fetch_jobcodes(opts: fetch_jobcodes_opts): Promise<fetch_jobcodes_result>;
    create_jobcode(data: { name: string; jobcode_type: string }): Promise<qbt_jobcode>;
    set_jobcode_active(id: number, active: boolean): Promise<void>;

    // Jobcode Assignments
    fetch_jobcode_assignments(opts: fetch_assignments_opts): Promise<fetch_assignments_result>;
    create_jobcode_assignment(user_id: number, jobcode_id: number): Promise<qbt_jobcode_assignment>;
    delete_jobcode_assignment(id: number): Promise<void>;
}
