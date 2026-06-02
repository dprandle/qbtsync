import mongo from "./db";
import { randomUUID } from "crypto";
import { save_timesheet_state, get_sync_state, cursor_progress, safe_cursor, CURSOR_EPOCH } from "./sync_state";
import { create_qbt_object_map_item, QBT_UPDATE_BY } from "./qbt_object_map";
import { qbt_client, type qbt_timesheet } from "./qbt_client_interface";
import { INVALID_DATETIME, is_active } from "./uobj_common";
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

function short_date_str(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function short_time_str(d: Date | string): string {
    const dt = typeof d === "string" ? new Date(d) : d;
    if (!dt.getTime() || dates_equal(dt, INVALID_DATETIME)) return "on-the-clock";
    return dt
        .toLocaleTimeString("en-US", {
            hour: "numeric",
            minute: "2-digit",
            hour12: true,
        })
        .toLowerCase();
}

function should_have_qbt_timesheet(archived_on: Date): boolean {
    return is_active(archived_on);
}

function get_timesheet_log_str(ts: qbt_timesheet) {
    return `${ts.date}: ${short_time_str(ts.start)} → ${short_time_str(ts.end)} (${ts.id} ${ts.user_id}:${ts.jobcode_id})`;
}

function get_time_record_log_str(tr: time_record) {
    return `${short_date_str(tr.date)}: ${short_time_str(tr.start)} → ${short_time_str(tr.end)} (${tr._id} ${tr.hrid}:${tr.cont_id})`;
}

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

function dates_equal(a: Date | string, b: Date | string): boolean {
    const a_dt = typeof a === "string" ? (a ? new Date(a) : INVALID_DATETIME) : a;
    const b_dt = typeof b === "string" ? (b ? new Date(b) : INVALID_DATETIME) : b;
    return a_dt.getTime() === b_dt.getTime();
}

// Ingests a single inbound QBT timesheet into our time_records. Returns true if it
// was updated (or is already up to date), false if it was skipped because the QBT
// user/jobcode is not mapped yet and should be retried on a later pass.
async function process_timesheet_update(ts: qbt_timesheet, qbt: qbt_client): Promise<boolean> {
    const map_col = mongo.get_qbt_map_objects();
    const incoming_modified = new Date(ts.last_modified);
    const mapping = await map_col.findOne({ type: "timesheet", qbt_id: ts.id });
    const trec_col = mongo.get_trecs();

    if (mapping && incoming_modified <= mapping.qbt_modified) {
        ilog(`[ts] Skipping timesheet - already up to date`);
    }

    // New timesheet from QBT — reverse-map the QBT user/jobcode to our ids
    const user_map = await map_col.findOne({ type: "user", qbt_id: ts.user_id });
    const jobcode_map = await map_col.findOne({ type: "jobcode", qbt_id: ts.jobcode_id });
    if (!user_map || !jobcode_map) {
        const jcstat = jobcode_map ? `ok (${jobcode_map.qbt_id})` : "missing";
        const usrstat = user_map ? `ok (${user_map.qbt_id})` : "missing";
        // The user and/or jobcode haven't synced yet; skip so this is retried
        // once those loops create the mappings (symmetric with outbound_sync).
        wlog(`[ts] Skipping without cursor advance - waiting on map entries -- jc:${jcstat} | usr: ${usrstat}`);
        return false;
    }

    if (mapping) {
        const trec = await trec_col.findOne({ _id: mapping.our_id });
        if (!trec) {
            await qbt.delete_timesheet(mapping.qbt_id);
            await map_col.deleteOne({ _id: mapping._id });
            ilog(`[ts] Deleted ${mapping._id} and associated mapping ${mapping._id} - trec removed`);
            return true;
        }

        const updates: Partial<time_record> = {};
        // We don't support updating start/date
        if (!dates_equal(trec.end, ts.end)) updates.end = ts.end ? new Date(ts.end) : INVALID_DATETIME;
        // Handle update jobcode... for now. Probably will remove this later
        if (trec.cont_id !== jobcode_map.our_id) updates.cont_id = jobcode_map.our_id;
        if (trec.notes !== ts.notes) {
            updates.notes = ts.notes;
        }

        if (Object.keys(updates).length > 0) {
            await trec_col.updateOne({ _id: trec._id }, updates);
            ilog(`[ts] Updated ${get_time_record_log_str(trec)} with:`, updates);
        } else {
            ilog(`[ts] No changes`);
        }

        const map_update = {
            $set: {
                qbt_modified: incoming_modified,
                last_update: { by: QBT_UPDATE_BY, on: new Date() },
            },
        };
        await map_col.updateOne({ type: "timesheet", qbt_id: ts.id }, map_update);
        ilog(`[ts] Updated mapping ${mapping._id} with updated ts last mod ${ts.last_modified}`);
    } else {
        const cont = await mongo.get_conts().findOne({ _id: jobcode_map.our_id });
        if (!cont) throw Error("Failed to fetch contract with id " + jobcode_map.our_id);
        const trec = timesheet_to_time_record(ts, user_map.our_id, cont);
        await trec_col.insertOne(trec);
        const map_obj = create_qbt_object_map_item(ts.id, trec._id, "timesheet", incoming_modified);
        await map_col.insertOne(map_obj);
        ilog(`[ts] Created:`, trec, `and associated mapping ${map_obj._id}`);
    }
    return true;
}

async function process_inbound_page(
    timesheets: qbt_timesheet[],
    progress: cursor_progress,
    qbt: qbt_client
): Promise<cursor_progress> {
    let { latest_resolved, earliest_unresolved } = progress;

    for (let i = 0; i < timesheets.length; ++i) {
        const ts = timesheets[i];
        const mod = new Date(ts.last_modified);
        ilog(`[ts] Processing update for ${get_timesheet_log_str(ts)} (${i + 1} of ${timesheets.length})`);
        const resolved = await process_timesheet_update(ts, qbt);
        if (resolved) {
            if (mod > latest_resolved) latest_resolved = mod;
        } else if (!earliest_unresolved || mod < earliest_unresolved) {
            earliest_unresolved = mod;
        }
    }
    return { latest_resolved, earliest_unresolved };
}

// Inbound sync of QBT timesheets into our time_records. Every fetch is bounded by
// config.timesheet_start_date (work-date floor, applied by the client) and by the
// modified_since cursor; on the first run the cursor is CURSOR_EPOCH, so this also
// performs the initial historical backfill. The cursor is only persisted at the
// end of a completed run — a crash mid-backfill leaves it untouched so the next
// run re-scans from scratch (ingest is idempotent). Advancing it per page would be
// unsafe: pages are not ordered by last_modified, so a page with a recent max
// would jump the cursor past older-modified rows on pages not yet fetched.
export async function update_time_recs_from_timesheets(qbt: qbt_client): Promise<void> {
    const state = get_sync_state();
    const modified_since = state.timesheets.last_synced ?? CURSOR_EPOCH;

    ilog(`[ts] Inbound sync since ${modified_since.toISOString()}`);

    let page = 1;
    let progress: cursor_progress = { latest_resolved: modified_since, earliest_unresolved: null };

    while (true) {
        const { items: timesheets, more } = await qbt.fetch_timesheets({ modified_since, page });
        ilog(`[ts] Fetched page ${page} with ${timesheets.length} timesheets`);

        if (timesheets.length === 0) break;

        progress = await process_inbound_page(timesheets, progress, qbt);

        if (!more) break;
        page++;
    }

    const latest_modified = safe_cursor(progress, modified_since);
    if (latest_modified > modified_since) {
        save_timesheet_state({ last_synced: latest_modified });
        ilog(`[ts] Inbound cursor advanced to ${latest_modified.toISOString()}`);
    } else {
        ilog("[ts] No new inbound timesheets.");
    }
}

// Processes a time_record and updates QBT with time record info. Returns true if it was handled
// (pushed, created, or intentionally nothing-to-do), false if it was skipped
// because its QBT user/jobcode mappings don't exist yet and it should be retried.
async function process_time_record_update(trec: time_record, qbt: qbt_client): Promise<boolean> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_qbt_timesheet(trec.archived_info.on);
    const mapping = await map_col.findOne({ type: "timesheet", our_id: trec._id });
    const on_the_clock = dates_equal(trec.end, INVALID_DATETIME);

    // Early out for self updates (when we ingest timesheets from QBT)
    if (trec.last_update.by.includes(QBT_UPDATE_BY)) {
        ilog(`[ts] Skipping trec - update is from ourself`);
        return true;
    }

    // If we have a timesheet mapped to a time record that has been archived, delete it
    // This is an early out because we really shouldn't care if hrid/cont_id map to user/jobcode or if they are valid even
    if (mapping && !want) {
        await qbt.delete_timesheet(mapping.qbt_id);
        await map_col.deleteOne({ _id: mapping._id });
        ilog(`[ts] Deleted ${mapping._id} and associated mapping ${mapping._id} - trec archived`);
        return true;
    }

    // No mapping: time_record was created directly in UberMail.
    // An incomplete record can never be created in QBT; treat it as done so the
    // cursor isn't stalled — it will reappear if hrid/cont_id are filled in later.
    if (!trec.hrid || !trec.cont_id) {
        const hridstat = trec.hrid ? `ok (${trec.hrid})` : "missing";
        const contstat = trec.cont_id ? `ok (${trec.cont_id})` : "missing";
        wlog(`[ts] Skipping with cursor advance -- hrid: ${hridstat} | cont_id: ${contstat}`);
        return true;
    }

    // Creating in QBT requires both user and jobcode mappings to exist.
    const jobcode_map = await map_col.findOne({ type: "jobcode", our_id: trec.cont_id });
    const user_map = await map_col.findOne({ type: "user", our_id: trec.hrid });
    if (!jobcode_map || !user_map) {
        const jcstat = jobcode_map ? `valid (${jobcode_map.qbt_id})` : "missing";
        const usrstat = user_map ? `valid (${user_map.qbt_id})` : "missing";
        wlog(`[ts] Skipping without cursor advance - waiting on map entries -- jc: ${jcstat} | usr: ${usrstat}`);
        // Not synced yet; retry on a later pass after the user/jobcode syncs run.
        return false;
    }

    const do_create = async () => {
        const timesheet = await qbt.create_timesheet({
            user_id: user_map.qbt_id,
            jobcode_id: jobcode_map.qbt_id,
            start: trec.start.toISOString(),
            end: on_the_clock ? "" : trec.end.toISOString(),
            date: trec.date.toISOString().slice(0, 10),
            notes: trec.notes,
            location: QBT_UPDATE_BY,
            on_the_clock,
        });
        const map_obj = create_qbt_object_map_item(
            timesheet.id,
            trec._id,
            "timesheet",
            new Date(timesheet.last_modified)
        );
        await map_col.insertOne(map_obj);
        ilog(`[ts] Created:`, timesheet, `and associated mapping ${map_obj._id}`);
    };

    if (mapping) {
        // We know Want is true here, because we would have early outed above if not
        try {
            let ts = await qbt.fetch_timesheet(mapping.qbt_id);
            const updates: Partial<qbt_timesheet> = {};
            if (!dates_equal(trec.start, ts.start)) updates.start = trec.start.toISOString();
            if (!dates_equal(trec.end, ts.end)) updates.end = !on_the_clock ? trec.end.toISOString() : "";
            if (!dates_equal(trec.date, ts.date)) updates.date = short_date_str(trec.date);
            if (trec.notes !== ts.notes) updates.notes = trec.notes;
            if (jobcode_map.qbt_id !== ts.jobcode_id) updates.jobcode_id = jobcode_map.qbt_id;

            if (Object.keys(updates).length > 0) {
                ts = await qbt.update_timesheet(ts.id, updates);
                ilog(`[ts] Updated ${get_timesheet_log_str(ts)} with:`, updates);

                // Here we gotta update our mapping last mod as well so that our ingest knows when a timesheet edit is from us
                const qbt_update = {
                    $set: {
                        qbt_modified: new Date(ts.last_modified),
                        last_update: { by: QBT_UPDATE_BY, on: new Date() },
                    },
                };
                await map_col.updateOne({ _id: mapping._id }, qbt_update);
                ilog(`[ts] Updated mapping ${mapping._id} with updated ts last mod ${ts.last_modified}`);
            } else {
                ilog(`[ts] No changes`);
            }
        } catch (err: any) {
            wlog(
                `[ts] Timesheet ${mapping.qbt_id} was deleted on qbt - removing mapping ${mapping._id} and recreating timesheet`
            );
            await map_col.deleteOne({ _id: mapping._id });
            await do_create();
        }
    } else if (want) {
        await do_create();
    } else {
        ilog(`[ts] No changes`);
    }
    return true;
}

export async function update_timesheets_from_time_recs(qbt: qbt_client): Promise<void> {
    const state = get_sync_state();
    const since = state.timesheets.outbound_last_synced ?? CURSOR_EPOCH;
    ilog(`[ts] Delta sync since: ${since.toISOString()}`);

    const changed = await mongo
        .get_trecs()
        .find({ "last_update.on": { $gt: since } })
        .toArray();

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    for (let i = 0; i < changed.length; ++i) {
        const trec = changed[i];
        const at = trec.last_update.on;
        ilog(`[ts] Processing update for ${get_time_record_log_str(trec)} (${i + 1} of ${changed.length})`);
        try {
            const resolved = await process_time_record_update(trec, qbt);
            if (resolved) {
                if (at > progress.latest_resolved) progress.latest_resolved = at;
            } else if (!progress.earliest_unresolved || at < progress.earliest_unresolved) {
                progress.earliest_unresolved = at;
            }
        } catch (err) {
            elog(`[ts] Outbound error for time_record ${trec._id}:`, err);
            if (!progress.earliest_unresolved || at < progress.earliest_unresolved) {
                progress.earliest_unresolved = at;
            }
        }
    }

    const latest = safe_cursor(progress, since);
    if (latest > since) {
        save_timesheet_state({ outbound_last_synced: latest });
        ilog(`[ts] Outbound cursor advanced to ${latest.toISOString()}`);
    } else {
        ilog("[ts] No outbound changes.");
    }
}
