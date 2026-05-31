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
import { config } from "./config";

const PAGE_SIZE = 100;

// Mock storage uses the QBT `id` directly as Mongo's `_id`. These helpers map
// between the wire shape (`id: number`) and the stored shape (`_id: number`).
type allowed_types =
| qbt_timesheet
| qbt_jobcode
| qbt_user
| qbt_jobcode_assignment;

type mock_doc<T extends allowed_types> = Omit<T, "id"> & { _id: number };

export function to_mock_doc<T extends allowed_types>(item: T): mock_doc<T> {
    const { id, ...rest } = item;
    return { _id: id, ...rest } as mock_doc<T>;
}

export function from_mock_doc<T extends allowed_types>(doc: mock_doc<T>): T {
    const { _id, ...rest } = doc;
    return { id: _id, ...rest } as unknown as T;
}

async function fetch_item<T extends allowed_types>(id: number, coll_name: string): Promise<T> {
    const coll = mongo.get_mock_db().collection<mock_doc<T>>(coll_name);
    const doc = await coll.findOne({_id: id} as any);
    if (!doc) {
        throw new Error(`Could not find id ${id} in ${coll_name}`);
    }
    return from_mock_doc<T>(doc as mock_doc<T>);
}

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
        } else {
            filter["start"] = { $gte: config.timesheet_start_date };
        }
        const docs = await col
            .find(filter)
            .skip((page - 1) * PAGE_SIZE)
            .limit(PAGE_SIZE + 1)
            .toArray();
        const more = docs.length > PAGE_SIZE;
        return { items: docs.slice(0, PAGE_SIZE).map((d) => from_mock_doc<qbt_timesheet>(d)), more };
    }

    async fetch_timesheet(id: number): Promise<qbt_timesheet> {
        return fetch_item<qbt_timesheet>(id, "timesheets");
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
            type: d.type,
            active: true,
            locked: 0,
            notes: d.notes,
            last_modified: now_iso(),
            tz: "America/New_York",
            customfields: {},
        };
        await mongo.get_mock_timesheets().insertOne(to_mock_doc(ts));
        return ts;
    }

    async update_timesheet(id: number, d: Partial<timesheet_write_data>): Promise<qbt_timesheet> {
        const last_modified = now_iso();
        await mongo.get_mock_timesheets().updateOne({ _id: id }, { $set: { ...d, last_modified } });
        const updated = await mongo.get_mock_timesheets().findOne({ _id: id });
        if (!updated) throw new Error(`Timesheet ${id} not found after update`);
        return from_mock_doc<qbt_timesheet>(updated);
    }

    async fetch_users(opts: fetch_users_opts): Promise<fetch_users_result> {
        const page = opts.page ?? 1;
        const filter: Record<string, unknown> = {};
        if (opts.modified_since) filter["last_modified"] = { $gt: opts.modified_since.toISOString() };
        if (opts.active) filter["active"] = opts.active;
        const docs = await mongo
            .get_mock_users()
            .find(filter)
            .skip((page - 1) * PAGE_SIZE)
            .limit(PAGE_SIZE + 1)
            .toArray();
        const more = docs.length > PAGE_SIZE;
        return { items: docs.slice(0, PAGE_SIZE).map((d) => from_mock_doc<qbt_user>(d)), more };
    }

    async fetch_user(id: number): Promise<qbt_user> {
        return fetch_item<qbt_user>(id, "users");
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
        await mongo.get_mock_users().insertOne(to_mock_doc(user));
        return user;
    }

    async update_user(id: number, d: Partial<qbt_user>): Promise<qbt_user> {
        const last_modified = now_iso();
        const { id: _ignored, ...patch } = d;
        await mongo.get_mock_users().updateOne({ _id: id }, { $set: { ...patch, last_modified } });
        const updated = await mongo.get_mock_users().findOne({ _id: id });
        if (!updated) throw new Error(`User ${id} not found after update`);
        return from_mock_doc<qbt_user>(updated);
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
        return { items: docs.slice(0, PAGE_SIZE).map((d) => from_mock_doc<qbt_jobcode>(d)), more };
    }

    async fetch_jobcode(id: number): Promise<qbt_jobcode> {
        return fetch_item<qbt_jobcode>(id, "jobcodes");
    }

    async create_jobcode(d: { name: string; jobcode_type: string }): Promise<qbt_jobcode> {
        const jc: qbt_jobcode = {
            id: next_mock_id(),
            parent_id: 0,
            name: d.name,
            active: true,
            last_modified: now_iso(),
        };
        await mongo.get_mock_jobcodes().insertOne(to_mock_doc(jc));
        return jc;
    }

    async update_jobcode(id: number, d: Partial<qbt_jobcode>): Promise<qbt_jobcode> {
        const last_modified = now_iso();
        const { id: _ignored, ...patch } = d;
        await mongo.get_mock_jobcodes().updateOne({ _id: id }, { $set: { ...patch, last_modified } });
        const updated = await mongo.get_mock_jobcodes().findOne({ _id: id });
        if (!updated) throw new Error(`Jobcode ${id} not found after update`);
        return from_mock_doc<qbt_jobcode>(updated);
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
        return { items: docs.slice(0, PAGE_SIZE).map((d) => from_mock_doc<qbt_jobcode_assignment>(d)), more };
    }

    async fetch_jobcode_assignment(id: number): Promise<qbt_jobcode_assignment> {
        return fetch_item<qbt_jobcode_assignment>(id, "jobcode_assignments");
    }

    async create_jobcode_assignment(user_id: number, jobcode_id: number): Promise<qbt_jobcode_assignment> {
        const asgn: qbt_jobcode_assignment = {
            id: next_mock_id(),
            user_id,
            jobcode_id,
            active: true,
            last_modified: now_iso(),
        };
        await mongo.get_mock_assignments().insertOne(to_mock_doc(asgn));
        return asgn;
    }

    async delete_jobcode_assignment(id: number): Promise<void> {
        await mongo.get_mock_assignments().deleteOne({ _id: id });
    }
}
