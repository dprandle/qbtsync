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
type allowed_types = qbt_timesheet | qbt_jobcode | qbt_user | qbt_jobcode_assignment;

type mock_doc<T extends allowed_types> = Omit<T, "id"> & { _id: number };

export function to_mock_doc<T extends allowed_types>(item: T): mock_doc<T> {
    const { id, ...rest } = item;
    return { _id: id, ...rest } as mock_doc<T>;
}

export function from_mock_doc<T extends allowed_types>(doc: mock_doc<T>): T {
    const { _id, ...rest } = doc;
    return { id: _id, ...rest } as unknown as T;
}

function expect_one<T>(items: T[], label: string, id: number): T {
    if (items.length !== 1) {
        throw new Error(`Expected 1 ${label} for id ${id}, got ${items.length}`);
    }
    return items[0];
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
        filter["on_the_clock"] = "both";
        if (opts.modified_since) {
            filter["last_modified"] = { $gt: opts.modified_since.toISOString() };
        } else if (!opts.ids?.length) {
            filter["start"] = { $gte: config.timesheet_start_date };
        }
        if (opts.ids?.length) filter["_id"] = { $in: opts.ids };
        const docs = await col
            .find(filter)
            .skip((page - 1) * PAGE_SIZE)
            .limit(PAGE_SIZE + 1)
            .toArray();
        const more = docs.length > PAGE_SIZE;
        return { items: docs.slice(0, PAGE_SIZE).map((d) => from_mock_doc<qbt_timesheet>(d)), more };
    }

    async fetch_timesheet(id: number): Promise<qbt_timesheet> {
        const { items } = await this.fetch_timesheets({ ids: [id] });
        return expect_one(items, "timesheet", id);
    }

    async create_timesheet(d: timesheet_write_data): Promise<qbt_timesheet> {
        const ts: qbt_timesheet = {
            id: next_mock_id(),
            user_id: d.user_id,
            jobcode_id: d.jobcode_id,
            start: d.start,
            end: d.end,
            date: d.date,
            notes: d.notes,
            location: d.location,
            on_the_clock: d.on_the_clock,
            last_modified: now_iso(),
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

    async delete_timesheet(id: number): Promise<void> {
        // Mirror QBT: the timesheet is removed from the live collection and a
        // copy is recorded in timesheets-deleted.
        const doc = await mongo.get_mock_timesheets().findOne({ _id: id });
        if (!doc) return;
        await mongo.get_mock_deleted_timesheets().insertOne(doc);
        await mongo.get_mock_timesheets().deleteOne({ _id: id });
    }

    async fetch_users(opts: fetch_users_opts): Promise<fetch_users_result> {
        const page = opts.page ?? 1;
        const filter: Record<string, unknown> = {};
        if (opts.modified_since) filter["last_modified"] = { $gt: opts.modified_since.toISOString() };
        // If active is both, we just don't add a filter for mock
        if (opts.active === "yes") filter["active"] = true;
        if (opts.active === "no")  filter["active"] = false;
        if (opts.ids?.length) filter["_id"] = { $in: opts.ids };
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
        // If active is both, we just don't add a filter for mock
        if (opts.active === "yes") filter["active"] = true;
        if (opts.active === "no") filter["active"] = false;
        if (opts.ids?.length) filter["_id"] = { $in: opts.ids };
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
        const { items } = await this.fetch_jobcodes({ ids: [id], active: "both" });
        return expect_one(items, "jobcode", id);
    }

    async create_jobcode(d: { name: string; jobcode_type: string }): Promise<qbt_jobcode> {
        const jc: qbt_jobcode = {
            id: next_mock_id(),
            name: d.name,
            active: true,
            last_modified: now_iso(),
            created: now_iso(),
        };
        await mongo.get_mock_jobcodes().insertOne(to_mock_doc(jc));
        return jc;
    }

    async update_jobcode(id: number, d: Partial<qbt_jobcode>): Promise<qbt_jobcode> {
        const last_modified = now_iso();
        const { id: _ignored, ...patch } = d;
        const update_obj = { $set: { ...patch, last_modified } };
        dlog("Sending jc update", update_obj);
        await mongo.get_mock_jobcodes().updateOne({ _id: id }, update_obj);
        const updated = await mongo.get_mock_jobcodes().findOne({ _id: id });
        if (!updated) throw new Error(`Jobcode ${id} not found after update`);
        return from_mock_doc<qbt_jobcode>(updated);
    }

    async fetch_jobcode_assignments(opts: fetch_assignments_opts): Promise<fetch_assignments_result> {
        const page = opts.page ?? 1;
        const filter: Record<string, unknown> = {};
        if (opts.jobcode_ids?.length) filter["jobcode_id"] = { $in: opts.jobcode_ids };
        if (opts.user_ids?.length) filter["user_id"] = { $in: opts.user_ids };
        if (opts.ids?.length) filter["_id"] = { $in: opts.ids };
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
        const { items } = await this.fetch_jobcode_assignments({ ids: [id] });
        return expect_one(items, "jobcode_assignment", id);
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
        // Mirror QBT: assignments are never truly deleted, just marked inactive.
        await mongo
            .get_mock_assignments()
            .updateOne({ _id: id }, { $set: { active: false, last_modified: now_iso() } });
    }
}
