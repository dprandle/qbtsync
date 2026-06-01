import mongo from "./db";
import { randomUUID } from "crypto";
import { save_timesheet_state, load_sync_state, cursor_progress, safe_cursor } from "./sync_state";
import { create_qbt_object_map_item, QBT_UPDATE_BY } from "./qbt_object_map";
import { qbt_client, type qbt_timesheet } from "./qbt_client_interface";
import { INVALID_DATETIME } from "./uobj_common";
import { change_info } from "./uobj_common";
import { contract_route_doc } from "./sync_jobcodes";
const TIME_RECORD_SCHEMA_VERSION = 1;

export type time_record = {
    _id: string;
    custom_params: Record<string, string>;
    archived_info: change_info;
    last_update: change_info;
    created: change_info;
    schema_version: number;
    hrid: string; // hresource id
    cont_id: string; // contract id
    notes: string;
    start: Date;
    end: Date;
    date: Date;
};

function tz_str(tz_bytes: number[]): string {
    return Buffer.from(tz_bytes).toString("utf8");
}

function day_start(start: Date, tz_bytes: number[]): Date {
    const tz_id = tz_str(tz_bytes);
    const fmt = new Intl.DateTimeFormat("en-US", {
        timeZone: tz_id,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
    });
    const fmt_parts = fmt.formatToParts(start);

    const find_type = (type: string, parts: Intl.DateTimeFormatPart[]) => {
        const val = parts.find((elem) => elem.type === type);
        return val!.value;
    };

    const year = find_type("year", fmt_parts);
    const month = find_type("month", fmt_parts);
    const day = find_type("day", fmt_parts);
    return new Date(`${year}-${month}-${day}T00:00:00Z`);
}

function timesheet_to_time_record(ts: qbt_timesheet, hres_id: string, cont: contract_route_doc): time_record {
    const now = new Date();
    const start = new Date(ts.start);
    const end = ts.end ? new Date(ts.end) : INVALID_DATETIME;
    return {
        _id: randomUUID(),
        custom_params: {},
        archived_info: { by: "", on: INVALID_DATETIME },
        last_update: { by: `${QBT_UPDATE_BY} (${ts.location})`, on: now },
        created: { by: `${QBT_UPDATE_BY} (${ts.location})`, on: now },
        schema_version: TIME_RECORD_SCHEMA_VERSION,
        hrid: hres_id,
        cont_id: cont._id,
        notes: ts.notes,
        start,
        end,
        date: day_start(start, cont.timezone),
    };
}

function dates_approx_equal(a: Date, b: string): boolean {
    // Compare within 1 second to avoid floating point / rounding issues
    return Math.abs(a.getTime() - new Date(b).getTime()) < 1000;
}

// Ingests a single inbound QBT timesheet into our time_records. Returns true if it
// was ingested (or is already up to date), false if it was skipped because the QBT
// user/jobcode is not mapped yet and should be retried on a later pass.
async function ingest_timesheet(ts: qbt_timesheet, qbt: qbt_client): Promise<boolean> {
    const map_col = mongo.get_qbt_map_objects();
    const incoming_modified = new Date(ts.last_modified);

    const mapping = await map_col.findOne({ type: "timesheet", qbt_id: ts.id });

    if (mapping) {
        if (incoming_modified <= mapping.qbt_modified) {
            return true; // already up to date
        }

        const trec = await mongo.get_trecs().findOne({ _id: mapping.our_id });
        if (!trec) {
            // Mapping exists but time_record is gone — just advance the bookkeeping fields
            await map_col.updateOne(
                { type: "timesheet", qbt_id: ts.id },
                { $set: { qbt_modified: incoming_modified, last_update: { by: QBT_UPDATE_BY, on: new Date() } } }
            );
            return true;
        }

        const changed =
            ts.notes !== trec.notes ||
            !dates_approx_equal(trec.start, ts.start) ||
            !dates_approx_equal(trec.end, ts.end) ||
            !dates_approx_equal(trec.date, ts.date);

        if (changed) {
            // QBT-side change detected; our time_record is authoritative — push it back
            const reverted = await qbt.update_timesheet(ts.id, {
                notes: trec.notes,
                start: trec.start.toISOString(),
                end: trec.end.toISOString(),
                date: trec.date.toISOString().slice(0, 10),
            });
            await map_col.updateOne(
                { type: "timesheet", qbt_id: ts.id },
                {
                    $set: {
                        qbt_modified: new Date(reverted.last_modified),
                        last_update: { by: QBT_UPDATE_BY, on: new Date() },
                    },
                }
            );
        } else {
            // Values match; just advance the modification cursor
            await map_col.updateOne(
                { type: "timesheet", qbt_id: ts.id },
                { $set: { qbt_modified: incoming_modified } }
            );
        }
        return true;
    } else {
        // New timesheet from QBT — reverse-map the QBT user/jobcode to our ids
        const user_map = await map_col.findOne({ type: "user", qbt_id: ts.user_id });
        const jobcode_map = await map_col.findOne({ type: "jobcode", qbt_id: ts.jobcode_id });
        if (!user_map || !jobcode_map) {
            // The user and/or jobcode haven't synced yet; skip so this is retried
            // once those loops create the mappings (symmetric with outbound_sync).
            console.warn(
                `[timesheets] Skipping QBT timesheet ${ts.id}: no mapping for ` +
                    `user_id=${ts.user_id} (${user_map ? "ok" : "missing"}), ` +
                    `jobcode_id=${ts.jobcode_id} (${jobcode_map ? "ok" : "missing"})`
            );
            return false;
        }

        const cont = await mongo.get_conts().findOne({ _id: jobcode_map.our_id });
        if (!cont) throw Error("Failed to fetch contract with id " + jobcode_map.our_id);
        const trec = timesheet_to_time_record(ts, user_map.our_id, cont);
        await mongo.get_trecs().insertOne(trec);
        const map_obj = create_qbt_object_map_item(ts.id, trec._id, "timesheet", incoming_modified);
        await map_col.insertOne(map_obj);
        return true;
    }
}

async function process_inbound_page(
    timesheets: qbt_timesheet[],
    progress: cursor_progress,
    qbt: qbt_client
): Promise<cursor_progress> {
    let { latest_resolved, earliest_unresolved } = progress;
    for (const ts of timesheets) {
        const mod = new Date(ts.last_modified);
        const resolved = await ingest_timesheet(ts, qbt);
        if (resolved) {
            if (mod > latest_resolved) latest_resolved = mod;
        } else if (!earliest_unresolved || mod < earliest_unresolved) {
            earliest_unresolved = mod;
        }
    }
    return { latest_resolved, earliest_unresolved };
}

export async function full_import(qbt: qbt_client): Promise<void> {
    console.log("[timesheets] Starting full import...");
    const state = load_sync_state();
    let page = state.timesheets.full_import_page;
    const since = state.timesheets.last_synced ?? new Date(0);
    let progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };

    while (true) {
        console.log(`[timesheets] Fetching page ${page}...`);
        const { items: timesheets, more } = await qbt.fetch_timesheets({ page });

        if (timesheets.length === 0) break;

        progress = await process_inbound_page(timesheets, progress, qbt);

        save_timesheet_state({ full_import_page: page, last_synced: safe_cursor(progress, since) });

        if (!more) break;
        page++;
    }

    save_timesheet_state({ full_import_complete: true, full_import_page: 1 });
    console.log("[timesheets] Full import complete.");
}

export async function incremental_sync(qbt: qbt_client): Promise<void> {
    const state = load_sync_state();
    const modified_since = state.timesheets.last_synced ?? new Date(0);

    console.log(`[timesheets] Inbound sync since ${modified_since.toISOString()}`);

    let page = 1;
    let progress: cursor_progress = { latest_resolved: modified_since, earliest_unresolved: null };

    while (true) {
        const { items: timesheets, more } = await qbt.fetch_timesheets({ modified_since, page });

        if (timesheets.length === 0) break;

        progress = await process_inbound_page(timesheets, progress, qbt);

        if (!more) break;
        page++;
    }

    const latest_modified = safe_cursor(progress, modified_since);
    if (latest_modified > modified_since) {
        save_timesheet_state({ last_synced: latest_modified });
        console.log(`[timesheets] Inbound cursor advanced to ${latest_modified.toISOString()}`);
    } else {
        console.log("[timesheets] No new inbound timesheets.");
    }
}

// Pushes a single outbound time_record to QBT. Returns true if it was handled
// (pushed, created, or intentionally nothing-to-do), false if it was skipped
// because its QBT user/jobcode mappings don't exist yet and it should be retried.
async function push_time_record(trec: time_record, qbt: qbt_client): Promise<boolean> {
    const map_col = mongo.get_qbt_map_objects();
    const mapping = await map_col.findOne({ type: "timesheet", our_id: trec._id });

    if (mapping) {
        if (trec.last_update.by !== QBT_UPDATE_BY) {
            // Desktop-originated edit — push to QBT
            const timesheet = await qbt.update_timesheet(mapping.qbt_id, {
                notes: trec.notes,
                start: trec.start.toISOString(),
                end: trec.end.toISOString(),
                date: trec.date.toISOString().slice(0, 10),
            });
            await map_col.updateOne(
                { type: "timesheet", our_id: trec._id },
                {
                    $set: {
                        qbt_modified: new Date(timesheet.last_modified),
                        last_update: { by: QBT_UPDATE_BY, on: new Date() },
                    },
                }
            );
            console.log(`[timesheets] Pushed edit for time_record ${trec._id} to QBT timesheet ${mapping.qbt_id}`);
        }
        return true;
    }

    // No mapping: time_record was created directly in UberMail.
    // An incomplete record can never be created in QBT; treat it as done so the
    // cursor isn't stalled — it will reappear if hrid/cont_id are filled in later.
    if (!trec.hrid || !trec.cont_id) return true;

    // Creating in QBT requires both user and jobcode mappings to exist.
    const user_map = await map_col.findOne({ type: "user", our_id: trec.hrid });
    const jobcode_map = await map_col.findOne({ type: "jobcode", our_id: trec.cont_id });
    if (!user_map || !jobcode_map) {
        // Not synced yet; retry on a later pass after the user/jobcode syncs run.
        return false;
    }

    const timesheet = await qbt.create_timesheet({
        user_id: user_map.qbt_id,
        jobcode_id: jobcode_map.qbt_id,
        start: trec.start.toISOString(),
        end: trec.end.toISOString(),
        date: trec.date.toISOString().slice(0, 10),
        type: "regular",
        notes: trec.notes,
    });
    const map_obj = create_qbt_object_map_item(timesheet.id, trec._id, "timesheet", new Date(timesheet.last_modified));
    await map_col.insertOne(map_obj);
    console.log(`[timesheets] Created QBT timesheet ${timesheet.id} for time_record ${trec._id}`);
    return true;
}

export async function outbound_sync(qbt: qbt_client): Promise<void> {
    const state = load_sync_state();
    const since = state.timesheets.outbound_last_synced ?? new Date(0);

    const changed = await mongo
        .get_trecs()
        .find({ "last_update.on": { $gt: since } })
        .toArray();

    if (changed.length === 0) return;

    console.log(`[timesheets] Outbound sync: ${changed.length} candidate(s)`);

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    for (const trec of changed) {
        const at = trec.last_update.on;
        try {
            const resolved = await push_time_record(trec, qbt);
            if (resolved) {
                if (at > progress.latest_resolved) progress.latest_resolved = at;
            } else if (!progress.earliest_unresolved || at < progress.earliest_unresolved) {
                progress.earliest_unresolved = at;
            }
        } catch (err) {
            console.error(`[timesheets] Outbound error for time_record ${trec._id}:`, err);
            if (!progress.earliest_unresolved || at < progress.earliest_unresolved) {
                progress.earliest_unresolved = at;
            }
        }
    }

    const latest = safe_cursor(progress, since);
    if (latest > since) {
        save_timesheet_state({ outbound_last_synced: latest });
        console.log(`[timesheets] Outbound cursor advanced to ${latest.toISOString()}`);
    } else {
        console.log("[timesheets] No outbound changes.");
    }
}
