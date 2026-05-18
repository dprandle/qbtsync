import { config } from "./config";
import { qbt_timesheet, qbt_timesheets_response } from "./types";

const BASE_URL = "https://rest.tsheets.com/api/v1";

async function qbt_fetch(path: string, params: Record<string, string>): Promise<unknown> {
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
        throw new Error(`QBT API error ${resp.status}: ${body}`);
    }

    return resp.json();
}

export type fetch_timesheets_opts = {
    modified_since?: Date;
    page?: number;
};

export type fetch_timesheets_result = {
    timesheets: qbt_timesheet[];
    more: boolean;
};

export async function fetch_timesheets(opts: fetch_timesheets_opts = {}): Promise<fetch_timesheets_result> {
    const params: Record<string, string> = {
        limit: "200",
        page: String(opts.page ?? 1),
    };

    if (opts.modified_since) {
        params["modified_since"] = opts.modified_since.toISOString();
    }

    const data = await qbt_fetch("/timesheets", params) as qbt_timesheets_response;
    const timesheets = Object.values(data.results.timesheets);
    return { timesheets, more: data.more };
}
