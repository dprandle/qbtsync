import { config } from "./config";
import {
    qbt_timesheet,
    qbt_timesheets_response,
    qbt_user,
    qbt_users_response,
    qbt_jobcode,
    qbt_jobcodes_response,
    qbt_jobcode_assignment,
    qbt_jobcode_assignments_response,
} from "./types";
import {
    qbt_client,
    fetch_timesheets_opts,
    fetch_timesheets_result,
    fetch_users_opts,
    fetch_users_result,
    fetch_jobcodes_opts,
    fetch_jobcodes_result,
    fetch_assignments_opts,
    fetch_assignments_result,
    timesheet_write_data,
} from "./qbt_client_interface";

const BASE_URL = "https://rest.tsheets.com/api/v1";

async function qbt_get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, val] of Object.entries(params)) {
        url.searchParams.set(key, val);
    }
    const resp = await fetch(url.toString(), {
        headers: {
            Authorization: `Bearer ${config.qbt_access_token}`,
            "Content-Type": "application/json",
        },
    });
    if (!resp.ok) {
        const body = await resp.text();
        throw new Error(`QBT API GET ${path} error ${resp.status}: ${body}`);
    }
    return resp.json();
}

async function qbt_post(path: string, body: unknown): Promise<unknown> {
    const resp = await fetch(`${BASE_URL}${path}`, {
        method: "POST",
        headers: {
            Authorization: `Bearer ${config.qbt_access_token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`QBT API POST ${path} error ${resp.status}: ${text}`);
    }
    return resp.json();
}

async function qbt_put(path: string, body: unknown): Promise<unknown> {
    const resp = await fetch(`${BASE_URL}${path}`, {
        method: "PUT",
        headers: {
            Authorization: `Bearer ${config.qbt_access_token}`,
            "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`QBT API PUT ${path} error ${resp.status}: ${text}`);
    }
    return resp.json();
}

async function qbt_delete(path: string, params: Record<string, string>): Promise<void> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, val] of Object.entries(params)) {
        url.searchParams.set(key, val);
    }
    const resp = await fetch(url.toString(), {
        method: "DELETE",
        headers: {
            Authorization: `Bearer ${config.qbt_access_token}`,
            "Content-Type": "application/json",
        },
    });
    if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`QBT API DELETE ${path} error ${resp.status}: ${text}`);
    }
}

export class qbt_api_client implements qbt_client {
    async fetch_timesheets(opts: fetch_timesheets_opts): Promise<fetch_timesheets_result> {
        const params: Record<string, string> = {
            limit: "100",
            page: String(opts.page ?? 1),
        };
        if (opts.modified_since) {
            params["modified_since"] = opts.modified_since.toISOString();
        } else {
            params["start_date"] = config.timesheet_start_date;
        }
        const data = (await qbt_get("/timesheets", params)) as qbt_timesheets_response;
        return { timesheets: Object.values(data.results.timesheets), more: data.more };
    }

    async create_timesheet(d: timesheet_write_data): Promise<qbt_timesheet> {
        const data = (await qbt_post("/timesheets", { data: [d] })) as qbt_timesheets_response;
        return Object.values(data.results.timesheets)[0];
    }

    async update_timesheet(id: number, d: Partial<timesheet_write_data>): Promise<qbt_timesheet> {
        const data = (await qbt_put("/timesheets", { data: [{ id, ...d }] })) as qbt_timesheets_response;
        return Object.values(data.results.timesheets)[0];
    }

    async fetch_users(opts: fetch_users_opts): Promise<fetch_users_result> {
        const params: Record<string, string> = {
            limit: "100",
            page: String(opts.page ?? 1),
        };
        if (opts.modified_since) params["modified_since"] = opts.modified_since.toISOString();
        const data = (await qbt_get("/users", params)) as qbt_users_response;
        return { users: Object.values(data.results.users), more: data.more };
    }

    async create_user(d: { username: string; email: string; first_name: string; last_name: string }): Promise<qbt_user> {
        const body = { data: [{ ...d, employee_role: "employee" }] };
        const data = (await qbt_post("/users", body)) as qbt_users_response;
        return Object.values(data.results.users)[0];
    }

    async set_user_active(id: number, active: boolean): Promise<void> {
        await qbt_put("/users", { data: [{ id, active }] });
    }

    async fetch_jobcodes(opts: fetch_jobcodes_opts): Promise<fetch_jobcodes_result> {
        const params: Record<string, string> = {
            limit: "100",
            page: String(opts.page ?? 1),
        };
        if (opts.modified_since) params["modified_since"] = opts.modified_since.toISOString();
        const data = (await qbt_get("/jobcodes", params)) as qbt_jobcodes_response;
        return { jobcodes: Object.values(data.results.jobcodes), more: data.more };
    }

    async create_jobcode(d: { name: string; jobcode_type: string }): Promise<qbt_jobcode> {
        const data = (await qbt_post("/jobcodes", { data: [d] })) as qbt_jobcodes_response;
        return Object.values(data.results.jobcodes)[0];
    }

    async set_jobcode_active(id: number, active: boolean): Promise<void> {
        await qbt_put("/jobcodes", { data: [{ id, active }] });
    }

    async fetch_jobcode_assignments(opts: fetch_assignments_opts): Promise<fetch_assignments_result> {
        const params: Record<string, string> = {
            limit: "100",
            page: String(opts.page ?? 1),
        };
        if (opts.jobcode_ids?.length) params["jobcode_ids"] = opts.jobcode_ids.join(",");
        if (opts.user_ids?.length) params["user_ids"] = opts.user_ids.join(",");
        const data = (await qbt_get("/jobcode_assignments", params)) as qbt_jobcode_assignments_response;
        return { assignments: Object.values(data.results.jobcode_assignments), more: data.more };
    }

    async create_jobcode_assignment(user_id: number, jobcode_id: number): Promise<qbt_jobcode_assignment> {
        const data = (await qbt_post("/jobcode_assignments", {
            data: [{ user_id, jobcode_id }],
        })) as qbt_jobcode_assignments_response;
        return Object.values(data.results.jobcode_assignments)[0];
    }

    async delete_jobcode_assignment(id: number): Promise<void> {
        await qbt_delete("/jobcode_assignments", { ids: String(id) });
    }
}
