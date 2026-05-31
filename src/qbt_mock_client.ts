import { randomUUID } from "crypto";
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
    type qbt_timesheet,
    type qbt_user,
    type qbt_jobcode,
    type qbt_jobcode_assignment,
} from "./qbt_client_interface";
import mongo from "./db";

const PAGE_SIZE = 100;

function next_mock_id(): number {
    // Use a monotonically increasing integer based on time + random suffix to avoid collisions
    return Date.now() * 1000 + Math.floor(Math.random() * 1000);
}

function now_iso(): string {
    return new Date().toISOString();
}

export class qbt_mock_client implements qbt_client {
    async fetch_timesheets(opts: fetch_timesheets_opts): Promise<fetch_timesheets_result> {
        const col = mongo.get_mock_timesheets();
        const page = opts.page ?? 1;
        const filter: Record<string, unknown> = {};
        if (opts.modified_since) {
            filter["last_modified"] = { $gt: opts.modified_since.toISOString() };
        }
        const docs = await col
            .find(filter)
            .skip((page - 1) * PAGE_SIZE)
            .limit(PAGE_SIZE + 1)
            .toArray();
        const more = docs.length > PAGE_SIZE;
        return { timesheets: docs.slice(0, PAGE_SIZE) as qbt_timesheet[], more };
    }

    async create_timesheet(d: timesheet_write_data): Promise<qbt_timesheet> {
        const ts: qbt_timesheet = {
            id: next_mock_id(),
            user_id: d.user_id,
            jobcode_id: d.jobcode_id,
            start: d.start,
            end: d.end,
            duration: 0,
            date: d.date,
            type: d.type as "regular" | "pto",
            active: true,
            locked: 0,
            notes: d.notes,
            last_modified: now_iso(),
            tz: "America/New_York",
            customfields: {},
        };
        await mongo.get_mock_timesheets().insertOne(ts as any);
        return ts;
    }

    async update_timesheet(id: number, d: Partial<timesheet_write_data>): Promise<qbt_timesheet> {
        const last_modified = now_iso();
        await mongo.get_mock_timesheets().updateOne({ id } as any, { $set: { ...d, last_modified } as any });
        const updated = await mongo.get_mock_timesheets().findOne({ id } as any);
        return updated as unknown as qbt_timesheet;
    }

    async fetch_users(opts: fetch_users_opts): Promise<fetch_users_result> {
        const page = opts.page ?? 1;
        const filter: Record<string, unknown> = {};
        if (opts.modified_since) {
            filter["last_modified"] = { $gt: opts.modified_since.toISOString() };
        }
        const docs = await mongo
            .get_mock_users()
            .find(filter)
            .skip((page - 1) * PAGE_SIZE)
            .limit(PAGE_SIZE + 1)
            .toArray();
        const more = docs.length > PAGE_SIZE;
        return { users: docs.slice(0, PAGE_SIZE) as unknown as qbt_user[], more };
    }

    async create_user(d: {
        username: string;
        email: string;
        first_name: string;
        last_name: string;
        mobile_number: string;
    }): Promise<qbt_user> {
        const user: qbt_user = {
            id: next_mock_id(),
            username: d.username,
            email: d.email,
            first_name: d.first_name,
            last_name: d.last_name,
            mobile_number: d.mobile_number,
            active: true,
            employee_role: "employee",
            last_modified: now_iso(),
        };
        await mongo.get_mock_users().insertOne(user);
        return user;
    }

    async set_user_active(id: number, active: boolean): Promise<void> {
        await mongo.get_mock_users().updateOne({ id } as any, { $set: { active, last_modified: now_iso() } });
    }

    async fetch_jobcodes(opts: fetch_jobcodes_opts): Promise<fetch_jobcodes_result> {
        const page = opts.page ?? 1;
        const filter: Record<string, unknown> = {};
        if (opts.modified_since) filter["last_modified"] = { $gt: opts.modified_since.toISOString() };
        if (opts.active) filter["active"] = opts.active;
        const docs = await mongo
            .get_mock_jobcodes()
            .find(filter)
            .skip((page - 1) * PAGE_SIZE)
            .limit(PAGE_SIZE + 1)
            .toArray();
        const more = docs.length > PAGE_SIZE;
        return { jobcodes: docs.slice(0, PAGE_SIZE) as unknown as qbt_jobcode[], more };
    }

    async create_jobcode(d: { name: string; jobcode_type: string }): Promise<qbt_jobcode> {
        const jc: qbt_jobcode = {
            id: next_mock_id(),
            parent_id: 0,
            name: d.name,
            active: true,
            last_modified: now_iso(),
        };
        await mongo.get_mock_jobcodes().insertOne(jc as any);
        return jc;
    }

    async set_jobcode_active(id: number, active: boolean): Promise<void> {
        await mongo.get_mock_jobcodes().updateOne({ id } as any, { $set: { active, last_modified: now_iso() } });
    }

    async fetch_jobcode_assignments(opts: fetch_assignments_opts): Promise<fetch_assignments_result> {
        const page = opts.page ?? 1;
        const filter: Record<string, unknown> = {};
        if (opts.jobcode_ids?.length) filter["jobcode_id"] = { $in: opts.jobcode_ids };
        if (opts.user_ids?.length) filter["user_id"] = { $in: opts.user_ids };
        const docs = await mongo
            .get_mock_assignments()
            .find(filter)
            .skip((page - 1) * PAGE_SIZE)
            .limit(PAGE_SIZE + 1)
            .toArray();
        const more = docs.length > PAGE_SIZE;
        return { assignments: docs.slice(0, PAGE_SIZE) as unknown as qbt_jobcode_assignment[], more };
    }

    async create_jobcode_assignment(user_id: number, jobcode_id: number): Promise<qbt_jobcode_assignment> {
        const asgn: qbt_jobcode_assignment = {
            id: next_mock_id(),
            user_id,
            jobcode_id,
            active: true,
            last_modified: now_iso(),
        };
        await mongo.get_mock_assignments().insertOne(asgn as any);
        return asgn;
    }

    async delete_jobcode_assignment(id: number): Promise<void> {
        await mongo.get_mock_assignments().deleteOne({ id } as any);
    }
}
