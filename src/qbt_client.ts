import { config } from "./config";
import { qbt_rate_limiter } from "./rate_limiter";
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
    fetch_deleted_timesheets_opts,
    fetch_deleted_timesheets_result,
    timesheet_write_data,
    type qbt_item_status,
    type qbt_timesheet,
    type qbt_timesheets_response,
    type qbt_user,
    type qbt_users_response,
    type qbt_jobcode,
    type qbt_jobcodes_response,
    type qbt_jobcode_assignment,
    type qbt_jobcode_assignments_response,
    type create_invitation_opts,
    type qbt_invite_result,
    type qbt_invitations_response,
    type qbt_query_filter,
    type qbt_timesheets_deleted_response,
} from "./qbt_client_interface";

const BASE_URL = "https://rest.tsheets.com/api/v1";

// QBT rejects the timestamp that Date.toISOString() produces: it does not accept
// the fractional-seconds component (".000") nor the "Z" zone shorthand. It wants
// ISO-8601 with whole seconds and a numeric UTC offset — the same shape it emits
// for last_modified. e.g. 2024-01-01T00:00:00.000Z -> 2024-01-01T00:00:00+00:00
function qbt_iso(d: Date): string {
    return d.toISOString().replace(/\.\d{3}Z$/, "+00:00");
}

// Timesheet start/end reach us as ISO strings serialized with Date.toISOString()
// (".000Z"), which QBT rejects on writes with a 417 the same way it rejects the
// modified_since query above. Re-normalize them to the whole-second numeric-offset
// shape. An empty string (on-the-clock end) is a valid value and passes through.
function normalize_ts_times<T extends { start?: string; end?: string }>(d: T): T {
    const out = { ...d };
    if (out.start) out.start = qbt_iso(new Date(out.start));
    if (out.end) out.end = qbt_iso(new Date(out.end));
    return out;
}

// Turn a free-form filter object into the flat string-valued param map qbt_get wants.
// Arrays become the comma-separated form QBT uses for list params (e.g. ids, user_ids);
// null/undefined entries are dropped so an absent filter key is simply omitted.
function filter_to_params(filter: qbt_query_filter): Record<string, string> {
    const params: Record<string, string> = {};
    for (const [key, val] of Object.entries(filter)) {
        if (val === undefined || val === null) continue;
        params[key] = Array.isArray(val) ? val.map(String).join(",") : String(val);
    }
    return params;
}

async function qbt_get(path: string, params: Record<string, string>): Promise<unknown> {
    const url = new URL(`${BASE_URL}${path}`);
    for (const [key, val] of Object.entries(params)) {
        url.searchParams.set(key, val);
    }
    await qbt_rate_limiter.acquire();
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
    await qbt_rate_limiter.acquire();
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
    await qbt_rate_limiter.acquire();
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

function expect_one<T>(items: T[], label: string, id: number): T {
    if (items.length !== 1) {
        throw new Error(`Expected 1 ${label} for id ${id}, got ${items.length}`);
    }
    return items[0];
}

// Batch write endpoints return HTTP 200 even when an individual item fails, with the
// failure carried in the per-item _status_code/_status_message. Without this check the
// caller would treat the error object as a real result (all real fields undefined) and
// record a phantom success. Throw instead so the per-item catch floors the cursor and
// retries.
function expect_ok<T extends qbt_item_status>(item: T | undefined, label: string, id: number): T {
    if (!item) {
        throw new Error(`QBT ${label} ${id}: no result returned`);
    }
    if (item._status_code !== undefined && item._status_code >= 300) {
        const extra = item._status_extra ? ` - ${item._status_extra}` : "";
        throw new Error(`QBT ${label} ${id} failed (${item._status_code}): ${item._status_message ?? "unknown"}${extra}`);
    }
    return item;
}

async function qbt_delete(path: string, params: Record<string, string>): Promise<void> {
    const url = new URL(`${BASE_URL}${path}`);

    for (const [key, val] of Object.entries(params)) {
        url.searchParams.set(key, val);
    }
    await qbt_rate_limiter.acquire();
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
            on_the_clock: "both"
        };
        if (opts.modified_since) params["modified_since"] = qbt_iso(opts.modified_since);
        if (!opts.ids?.length) params["start_date"] = config.timesheet_start_date;
        if (opts.ids?.length) params["ids"] = opts.ids.join(",");
        const data = (await qbt_get("/timesheets", params)) as qbt_timesheets_response;
        return { items: Object.values(data.results.timesheets), more: data.more };
    }

    async fetch_timesheet(id: number): Promise<qbt_timesheet> {
        const { items } = await this.fetch_timesheets({ ids: [id] });
        return expect_one(items, "timesheet", id);
    }

    async create_timesheet(d: timesheet_write_data): Promise<qbt_timesheet> {
        const data = (await qbt_post("/timesheets", { data: [normalize_ts_times(d)] })) as qbt_timesheets_response;
        return expect_ok(Object.values(data.results.timesheets)[0], "timesheet create", 0);
    }

    async update_timesheet(id: number, d: Partial<timesheet_write_data>): Promise<qbt_timesheet> {
        const data = (await qbt_put("/timesheets", {
            data: [{ id, ...normalize_ts_times(d) }],
        })) as qbt_timesheets_response;
        return expect_ok(Object.values(data.results.timesheets)[0], "timesheet update", id);
    }

    async delete_timesheets(ids: number[]): Promise<void> {
        if (ids.length === 0) return;
        await qbt_delete("/timesheets", { ids: ids.join(",") });
    }

    async delete_timesheet(id: number): Promise<void> {
        await this.delete_timesheets([id]);
    }

    async fetch_deleted_timesheets(opts: fetch_deleted_timesheets_opts): Promise<fetch_deleted_timesheets_result> {
        const params: Record<string, string> = {
            limit: "100",
            page: String(opts.page ?? 1),
            modified_since: qbt_iso(opts.modified_since),
        };
        const data = (await qbt_get("/timesheets_deleted", params)) as qbt_timesheets_deleted_response;
        return { ids: Object.values(data.results.timesheets_deleted).map((t) => t.id), more: data.more };
    }

    async fetch_users(opts: fetch_users_opts): Promise<fetch_users_result> {
        const params: Record<string, string> = {
            limit: "100",
            page: String(opts.page ?? 1),
            active: opts.active,
        };
        if (opts.modified_since) params["modified_since"] = qbt_iso(opts.modified_since);
        if (opts.ids?.length) params["ids"] = opts.ids.join(",");
        const data = (await qbt_get("/users", params)) as qbt_users_response;
        return { items: Object.values(data.results.users), more: data.more };
    }

    async fetch_user(id: number): Promise<qbt_user> {
        const { items } = await this.fetch_users({ ids: [id], active: "both" });
        return expect_one(items, "user", id);
    }

    async create_user(d: {
        username: string;
        email: string;
        first_name: string;
        last_name: string;
        mobile_number: string;
    }): Promise<qbt_user> {
        const body = { data: [{ ...d, employee_role: "employee" }] };
        const data = (await qbt_post("/users", body)) as qbt_users_response;
        return expect_ok(Object.values(data.results.users)[0], "user create", 0);
    }

    async update_user(id: number, d: Partial<qbt_user>): Promise<qbt_user> {
        const data = (await qbt_put("/users", { data: [{ ...d, id }] })) as qbt_users_response;
        return expect_ok(Object.values(data.results.users)[0], "user update", id);
    }

    async fetch_jobcodes(opts: fetch_jobcodes_opts): Promise<fetch_jobcodes_result> {
        const params: Record<string, string> = {
            limit: "100",
            page: String(opts.page ?? 1),
            active: opts.active,
        };
        if (opts.modified_since) params["modified_since"] = qbt_iso(opts.modified_since);
        if (opts.ids?.length) params["ids"] = opts.ids.join(",");
        const data = (await qbt_get("/jobcodes", params)) as qbt_jobcodes_response;
        return { items: Object.values(data.results.jobcodes), more: data.more };
    }

    async fetch_jobcode(id: number): Promise<qbt_jobcode> {
        const { items } = await this.fetch_jobcodes({ ids: [id], active: "both" });
        return expect_one(items, "jobcode", id);
    }

    async create_jobcode(d: { name: string; jobcode_type: string }): Promise<qbt_jobcode> {
        const data = (await qbt_post("/jobcodes", { data: [d] })) as qbt_jobcodes_response;
        return expect_ok(Object.values(data.results.jobcodes)[0], "jobcode create", 0);
    }

    async update_jobcode(id: number, d: Partial<qbt_jobcode>): Promise<qbt_jobcode> {
        const data = (await qbt_put("/jobcodes", { data: [{ ...d, id }] })) as qbt_jobcodes_response;
        return expect_ok(Object.values(data.results.jobcodes)[0], "jobcode update", id);
    }

    async fetch_jobcode_assignments(opts: fetch_assignments_opts): Promise<fetch_assignments_result> {
        const params: Record<string, string> = {
            limit: "100",
            page: String(opts.page ?? 1),
        };
        if (opts.modified_since) params["modified_since"] = qbt_iso(opts.modified_since);
        if (opts.jobcode_id != null) params["jobcode_id"] = String(opts.jobcode_id);
        if (opts.user_ids?.length) params["user_ids"] = opts.user_ids.join(",");
        if (opts.ids?.length) params["ids"] = opts.ids.join(",");
        const data = (await qbt_get("/jobcode_assignments", params)) as qbt_jobcode_assignments_response;
        return { items: Object.values(data.results.jobcode_assignments), more: data.more };
    }

    async fetch_jobcode_assignment(id: number): Promise<qbt_jobcode_assignment> {
        const { items } = await this.fetch_jobcode_assignments({ ids: [id] });
        return expect_one(items, "jobcode_assignment", id);
    }

    async create_jobcode_assignment(user_id: number, jobcode_id: number): Promise<qbt_jobcode_assignment> {
        const data = (await qbt_post("/jobcode_assignments", {
            data: [{ user_id, jobcode_id }],
        })) as qbt_jobcode_assignments_response;
        return expect_ok(Object.values(data.results.jobcode_assignments)[0], "jobcode_assignment create", 0);
    }

    async delete_jobcode_assignment(id: number): Promise<void> {
        await qbt_delete("/jobcode_assignments", { ids: String(id) });
    }

    async create_invitation(opts: create_invitation_opts): Promise<qbt_invite_result> {
        const data = (await qbt_post("/invitations", { data: [opts] })) as qbt_invitations_response;
        return Object.values(data.results.invites)[0];
    }

    async query_timesheets(filter: qbt_query_filter): Promise<qbt_timesheet[]> {
        const data = (await qbt_get("/timesheets", filter_to_params(filter))) as qbt_timesheets_response;
        return Object.values(data.results.timesheets);
    }

    async query_users(filter: qbt_query_filter): Promise<qbt_user[]> {
        const data = (await qbt_get("/users", filter_to_params(filter))) as qbt_users_response;
        return Object.values(data.results.users);
    }

    async query_jobcodes(filter: qbt_query_filter): Promise<qbt_jobcode[]> {
        const data = (await qbt_get("/jobcodes", filter_to_params(filter))) as qbt_jobcodes_response;
        return Object.values(data.results.jobcodes);
    }

    async query_jobcode_assignments(filter: qbt_query_filter): Promise<qbt_jobcode_assignment[]> {
        const data = (await qbt_get("/jobcode_assignments", filter_to_params(filter))) as qbt_jobcode_assignments_response;
        return Object.values(data.results.jobcode_assignments);
    }
}
