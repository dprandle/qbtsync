import { qbt_timesheet, qbt_user, qbt_jobcode, qbt_jobcode_assignment } from "./types";

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
};

export type fetch_jobcodes_result = {
    jobcodes: qbt_jobcode[];
    more: boolean;
};

export type fetch_assignments_opts = {
    page?: number;
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

export interface qbt_client {
    // Timesheets
    fetch_timesheets(opts: fetch_timesheets_opts): Promise<fetch_timesheets_result>;
    create_timesheet(data: timesheet_write_data): Promise<qbt_timesheet>;
    update_timesheet(id: number, data: Partial<timesheet_write_data>): Promise<qbt_timesheet>;

    // Users
    fetch_users(opts: fetch_users_opts): Promise<fetch_users_result>;
    create_user(data: { username: string; email: string; first_name: string; last_name: string }): Promise<qbt_user>;
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
