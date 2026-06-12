import mongo from "./db";
import type { AnyBulkWriteOperation } from "mongodb";
import { save_timesheet_state, get_sync_state, cursor_progress, safe_cursor, CURSOR_EPOCH } from "./sync_state";
import { create_qbt_object_map_item, primary_by_our_id, type qbt_object_map } from "./qbt_object_map";
import { qbt_client, fetch_all_by_ids, type qbt_timesheet } from "./qbt_client_interface";
import {
    INVALID_DATETIME,
    OUR_UPDATE_BY,
    changed_by_us,
    is_active,
    make_ci_not_archived,
    make_ci_now,
} from "./uobj_common";
import { change_info } from "./uobj_common";
import { contract_route_doc, should_have_active_qbt_jobcode } from "./sync_jobcodes";
import { hresource_doc, should_have_qbt_user } from "./sync_users";
import { config } from "./config";
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

// These are qbt users that never had an HRES - we keep them here in case we encounter any timesheets with them
const QBT_USER_IDS_NO_HRES = new Set([
    1200741, 1200896, 1833712, 1285222, 1285225, 1255926, 1853612, 1853634, 54199, 1266424, 1266726, 1257013, 1537602,
    1537620, 1241586, 1283131,
]);

const QBT_JOBCODE_IDS_NO_CONT = new Set([
    4087983, 16065944, 16082052, 18253115, 1688109, 2552608, 2785597, 2785599, 2788228, 2820824, 13699048, 26495506,
    27721302, 1687361, 1687363, 1688103,
]);

function short_date_str(d: Date): string {
    return d.toISOString().slice(0, 10);
}

function short_time_str(d: Date | string | null | undefined): string {
    const dt = typeof d === "string" ? new Date(d) : d;
    if (!dt || Number.isNaN(dt.getTime()) || dates_equal(dt, INVALID_DATETIME)) {
        return "on-the-clock";
    }
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

// `cont` is null for uncharged time (QBT jobcode_id 0): the worker logged time
// without picking a jobcode, so there's no contract to map. We still record the time,
// with an empty cont_id. Without a contract we have no timezone to derive the work
// day from, so we use QBT's own ts.date (already the work-local YYYY-MM-DD) parsed at
// UTC midnight — the same shape day_start produces for the charged case.
function timesheet_to_time_record(ts: qbt_timesheet, hres_id: string, cont: contract_route_doc | null): time_record {
    const start = new Date(ts.start);
    const end = ts.end ? new Date(ts.end) : INVALID_DATETIME;
    const ci = make_ci_now(` (${ts.location})`);
    return {
        _id: ts.id.toString(),
        custom_params: {},
        archived_info: make_ci_not_archived(),
        last_update: ci,
        created: ci,
        schema_version: TIME_RECORD_SCHEMA_VERSION,
        hrid: hres_id,
        cont_id: cont ? cont._id : "",
        notes: ts.notes,
        start,
        end,
        date: cont ? day_start(start, cont.timezone) : new Date(`${ts.date}T00:00:00Z`),
    };
}

function dates_equal(a: Date | string, b: Date | string): boolean {
    const a_dt = typeof a === "string" ? (a ? new Date(a) : INVALID_DATETIME) : a;
    const b_dt = typeof b === "string" ? (b ? new Date(b) : INVALID_DATETIME) : b;
    return a_dt.getTime() === b_dt.getTime();
}

// Per-page working set for inbound processing. The maps are a read-through cache
// pre-loaded once per page (avoiding a findOne per item); they're also written
// through as ops are queued, so the per-item logic sees its own earlier writes.
// The *_ops buffers and qbt_delete_ids are flushed in bulk at the end of the page.
type inbound_batch = {
    ts_maps: Map<number, qbt_object_map>; // timesheet mappings keyed by qbt_id
    user_maps: Map<number, qbt_object_map>; // user mappings keyed by qbt_id
    jc_maps: Map<number, qbt_object_map>; // jobcode mappings keyed by qbt_id
    trecs: Map<string, time_record>; // time_records keyed by _id
    conts: Map<string, contract_route_doc>; // contracts keyed by _id
    trec_ops: AnyBulkWriteOperation<time_record>[];
    map_ops: AnyBulkWriteOperation<qbt_object_map>[];
    qbt_delete_ids: number[];
};

// Bulk-loads everything the page's items will read, in two dependency waves: the
// three mapping sets first, then the trecs/contracts they point at.
async function load_inbound_batch(timesheets: qbt_timesheet[]): Promise<inbound_batch> {
    const map_col = mongo.get_qbt_map_objects();
    const ts_ids = [...new Set(timesheets.map((t) => t.id))];
    const user_ids = [...new Set(timesheets.map((t) => t.user_id))];
    const jc_ids = [...new Set(timesheets.map((t) => t.jobcode_id))];

    const [ts_map_docs, user_map_docs, jc_map_docs] = await Promise.all([
        map_col.find({ type: "timesheet", qbt_id: { $in: ts_ids } }).toArray(),
        map_col.find({ type: "user", qbt_id: { $in: user_ids } }).toArray(),
        map_col.find({ type: "jobcode", qbt_id: { $in: jc_ids } }).toArray(),
    ]);

    const [trec_docs, cont_docs] = await Promise.all([
        mongo
            .get_trecs()
            .find({ _id: { $in: ts_map_docs.map((m) => m.our_id) } })
            .toArray(),
        mongo
            .get_conts()
            .find({ _id: { $in: jc_map_docs.map((m) => m.our_id) } })
            .toArray(),
    ]);

    return {
        ts_maps: new Map(ts_map_docs.map((m) => [m.qbt_id, m])),
        user_maps: new Map(user_map_docs.map((m) => [m.qbt_id, m])),
        jc_maps: new Map(jc_map_docs.map((m) => [m.qbt_id, m])),
        trecs: new Map(trec_docs.map((t) => [t._id, t])),
        conts: new Map(cont_docs.map((c) => [c._id, c])),
        trec_ops: [],
        map_ops: [],
        qbt_delete_ids: [],
    };
}

// Sends the queued work over the wire. QBT deletes go first (they can't be part of
// the Mongo transaction); doing them before commit means the worst case is a harmless
// orphan mapping rather than a resurrected timesheet. The trec and map writes then
// commit together in one transaction, so a failure leaves no partial state — the run
// aborts with the cursor unsaved and the next (idempotent) re-scan reconciles. Per
// page this is at most ~100 timesheets, so the transaction stays well within limits.
async function flush_inbound_batch(batch: inbound_batch, qbt: qbt_client): Promise<void> {
    if (batch.qbt_delete_ids.length > 0) await qbt.delete_timesheets(batch.qbt_delete_ids);
    if (batch.trec_ops.length === 0 && batch.map_ops.length === 0) return;
    await mongo.with_transaction(async (session) => {
        if (batch.trec_ops.length > 0) await mongo.get_trecs().bulkWrite(batch.trec_ops, { session });
        if (batch.map_ops.length > 0) await mongo.get_qbt_map_objects().bulkWrite(batch.map_ops, { session });
    });
}

// Ingests a single inbound QBT timesheet, reading from and queuing writes into the
// page batch (no network/db I/O of its own). Returns true if it was handled (or is
// already up to date), false if skipped because the QBT user/jobcode is not mapped
// yet and should be retried on a later pass.
function process_timesheet_update(ts: qbt_timesheet, batch: inbound_batch): boolean {
    const incoming_modified = new Date(ts.last_modified);
    const mapping = batch.ts_maps.get(ts.id);

    if (mapping && incoming_modified <= mapping.qbt_modified) {
        ilog(`[ts] Skipping timesheet - already up to date`);
        return true;
    }

    // Reverse-map the QBT user/jobcode to our ids.
    const user_map = batch.user_maps.get(ts.user_id);
    if (!user_map && QBT_USER_IDS_NO_HRES.has(ts.user_id)) {
        wlog(`[ts] Skipping with cursor advance - got known user id that doesn't match to hres -- usr: ${ts.user_id}`);
        return true;
    }

    // jobcode_id 0 is uncharged time: the worker logged time in the QBT app without
    // picking a jobcode (often because none was available to them). We still ingest it
    // as a time_record, just with an empty cont_id and no jobcode mapping required.
    const uncharged = ts.jobcode_id === 0;
    const jobcode_map = uncharged ? undefined : batch.jc_maps.get(ts.jobcode_id);
    if (!uncharged && !jobcode_map && QBT_JOBCODE_IDS_NO_CONT.has(ts.jobcode_id)) {
        wlog(`[ts] Skipping with cursor advance - got known jobcode id that doesn't match to contract -- jc: ${ts.jobcode_id}`);
        return true;
    }

    if (!user_map || (!uncharged && !jobcode_map)) {
        const jcstat = uncharged
            ? "uncharged (jc 0)"
            : jobcode_map
              ? `ok (${jobcode_map.qbt_id} -> ${jobcode_map.our_id})`
              : `${ts.jobcode_id} -> missing`;
        const usrstat = user_map ? `ok (${user_map.qbt_id} -> ${user_map.our_id})` : `${ts.user_id} -> missing`;
        // The user and/or jobcode haven't synced yet; skip so this is retried
        // once those loops create the mappings (symmetric with outbound_sync).
        wlog(`[ts] Skipping without cursor advance - waiting on map entries -- jc:${jcstat} | usr: ${usrstat}`);
        return false;
    }

    if (mapping) {
        const trec = batch.trecs.get(mapping.our_id);
        if (!trec) {
            batch.qbt_delete_ids.push(mapping.qbt_id);
            batch.map_ops.push({ deleteOne: { filter: { _id: mapping._id } } });
            batch.ts_maps.delete(ts.id);
            ilog(`[ts] Deleting qbt ${mapping.qbt_id} and mapping ${mapping._id} - trec removed`);
            return true;
        }

        const updates: Partial<time_record> = {};
        // We don't support updating start/date
        if (!dates_equal(trec.end, ts.end)) updates.end = ts.end ? new Date(ts.end) : INVALID_DATETIME;
        // Handle update jobcode... for now. Probably will remove this later. Uncharged
        // (jobcode 0) resolves to an empty cont_id, so a worker clearing or setting a
        // jobcode flips cont_id accordingly.
        const desired_cont = jobcode_map ? jobcode_map.our_id : "";
        if (trec.cont_id !== desired_cont) updates.cont_id = desired_cont;
        if (trec.notes !== ts.notes) {
            updates.notes = ts.notes;
        }

        if (Object.keys(updates).length > 0) {
            batch.trec_ops.push({ updateOne: { filter: { _id: trec._id }, update: { $set: updates } } });
            Object.assign(trec, updates);
            ilog(`[ts] Updated ${get_time_record_log_str(trec)} with:`, updates);
        } else {
            ilog(`[ts] No changes`);
        }

        batch.map_ops.push({
            updateOne: {
                filter: { _id: mapping._id },
                update: { $set: { qbt_modified: incoming_modified, last_update: make_ci_now() } },
            },
        });
        mapping.qbt_modified = incoming_modified;
        ilog(`[ts] Updated mapping ${mapping._id} with updated ts last mod ${ts.last_modified}`);
    } else {
        // No jobcode_map for uncharged time (jobcode 0) — cont stays null and the trec
        // gets an empty cont_id. Charged time must resolve to a real contract.
        const cont = jobcode_map ? batch.conts.get(jobcode_map.our_id) : undefined;
        if (jobcode_map && !cont) throw Error("Failed to fetch contract with id " + jobcode_map.our_id);
        const trec = timesheet_to_time_record(ts, user_map.our_id, cont ?? null);
        batch.trec_ops.push({ insertOne: { document: trec } });
        batch.trecs.set(trec._id, trec);
        const map_obj = create_qbt_object_map_item(ts.id, trec._id, "timesheet", incoming_modified);
        batch.map_ops.push({ insertOne: { document: map_obj } });
        batch.ts_maps.set(ts.id, map_obj);
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
    const batch = await load_inbound_batch(timesheets);

    for (let i = 0; i < timesheets.length; ++i) {
        const ts = timesheets[i];
        const mod = new Date(ts.last_modified);
        ilog(`[ts] Processing update for ${get_timesheet_log_str(ts)} (${i + 1} of ${timesheets.length})`);
        let resolved: boolean;
        try {
            resolved = process_timesheet_update(ts, batch);
        } catch (err) {
            // A thrown row is a data-integrity problem that won't fix itself on retry
            // (e.g. a jobcode mapping whose contract was deleted, or a contract with an
            // invalid timezone). Log loudly and skip it so one bad row can't wedge the
            // whole inbound scan; treat as resolved so the cursor advances past it. Both
            // current throw sites fire before any op is queued into batch, so skipping
            // here leaves the page batch consistent.
            elog(`[ts] Skipping unprocessable timesheet ${get_timesheet_log_str(ts)} - advancing past it:`, err);
            resolved = true;
        }
        if (resolved) {
            if (mod > latest_resolved) latest_resolved = mod;
        } else if (!earliest_unresolved || mod < earliest_unresolved) {
            earliest_unresolved = mod;
        }
    }

    await flush_inbound_batch(batch, qbt);
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
//
// The cursor advances to the moment the scan *started* (minus a small skew pad), not
// to the newest last_modified we observed. The scan spans a window of wall-clock time
// across many page fetches, and a row on an already-fetched page can be edited before
// the scan ends; advancing only to scan_start guarantees that edit (stamped
// >= scan_start by QBT's clock) is re-fetched next run. scan_start alone covers the
// full scan duration; the pad only absorbs clock skew between us and QBT (see config).
export async function update_time_recs_from_timesheets(qbt: qbt_client): Promise<void> {
    const state = get_sync_state();
    const modified_since = state.timesheets.last_synced ?? CURSOR_EPOCH;
    const scan_start = new Date(Date.now() - config.qbt_clock_skew_pad_ms);

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

    // Advance to scan_start (see above), still capped below any item we skipped this
    // run (earliest_unresolved) and floored at the existing cursor by safe_cursor.
    const next_cursor = safe_cursor({ ...progress, latest_resolved: scan_start }, modified_since);
    if (next_cursor > modified_since) {
        save_timesheet_state({ last_synced: next_cursor });
        ilog(`[ts] Inbound cursor advanced to ${next_cursor.toISOString()}`);
    } else {
        ilog("[ts] No inbound cursor advance.");
    }
}

// Per-run read cache for the outbound timesheet sync. The whole changed set's
// mappings and current QBT timesheets are loaded once up front so the per-item loop
// does no reads of its own (it still writes per item). Writes stay per-item because
// QBT create/update can't share a transaction with our Mongo write; only the reads
// are batched here.
type outbound_ts_cache = {
    ts_maps: Map<string, qbt_object_map>; // timesheet mappings by our_id (trec._id)
    user_maps: Map<string, qbt_object_map>; // user mappings by our_id (trec.hrid)
    jc_maps: Map<string, qbt_object_map>; // jobcode mappings by our_id (trec.cont_id)
    qbt_ts: Map<number, qbt_timesheet>; // current QBT timesheets by qbt id
    hres: Map<string, hresource_doc>; // hresources by _id (trec.hrid) — gates creation on time tracking
    conts: Map<string, contract_route_doc>; // contracts by _id (trec.cont_id)
};

async function load_outbound_ts_cache(trecs: time_record[], qbt: qbt_client): Promise<outbound_ts_cache> {
    const map_col = mongo.get_qbt_map_objects();
    const cont_ids = [...new Set(trecs.map((t) => t.cont_id).filter(Boolean))];
    const hr_ids = [...new Set(trecs.map((t) => t.hrid).filter(Boolean))];

    const [ts_map_docs, jc_map_docs, user_map_docs, hres_docs, cont_docs] = await Promise.all([
        map_col.find({ type: "timesheet", our_id: { $in: trecs.map((t) => t._id) } }).toArray(),
        map_col.find({ type: "jobcode", our_id: { $in: cont_ids } }).toArray(),
        map_col.find({ type: "user", our_id: { $in: hr_ids } }).toArray(),
        mongo
            .get_hresources()
            .find({ _id: { $in: hr_ids } })
            .toArray(),
        mongo
            .get_conts()
            .find({ _id: { $in: cont_ids } })
            .toArray(),
    ]);

    // fetch_all_by_ids chunks by 100, so N per-item fetch_timesheet calls collapse to ceil(N/100).
    const qbt_list = await fetch_all_by_ids(
        ts_map_docs.map((m) => m.qbt_id),
        (ids) => qbt.fetch_timesheets({ ids })
    );

    return {
        ts_maps: new Map(ts_map_docs.map((m) => [m.our_id, m])),
        // New timesheets are created under the primary (lowest link_id) user/jobcode
        // per hres/contract — duplicate links are archived objects kept only so their
        // existing timesheets resolve inbound, never for new writes. (Timesheets are
        // 1:1 with a trec, so ts_maps needs no primary selection.)
        user_maps: primary_by_our_id(user_map_docs),
        jc_maps: primary_by_our_id(jc_map_docs),
        qbt_ts: new Map(qbt_list.map((t) => [t.id, t])),
        hres: new Map(hres_docs.map((h) => [h._id, h])),
        conts: new Map(cont_docs.map((c) => [c._id, c])),
    };
}

// Processes a time_record and updates QBT with time record info. Returns true if it was handled
// (pushed, created, or intentionally nothing-to-do), false if it was skipped
// because its QBT user/jobcode mappings don't exist yet and it should be retried.
// Reads come from the prefetched cache; writes are issued per item.
async function process_time_record_update(
    trec: time_record,
    qbt: qbt_client,
    cache: outbound_ts_cache
): Promise<boolean> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_qbt_timesheet(trec.archived_info.on);
    const mapping = cache.ts_maps.get(trec._id);
    const on_the_clock = dates_equal(trec.end, INVALID_DATETIME);

    // Early out for self updates (when we ingest timesheets from QBT)
    if (changed_by_us(trec.last_update)) {
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

    // Whether this trec's person should have time in QBT at all. Same predicate that
    // governs whether their QBT user exists (the hres tt_flag is the source of truth),
    // so creation here stays symmetric with user existence. A missing hres counts as
    // "should not track" — we won't create time for someone we can't confirm.
    const hres = cache.hres.get(trec.hrid);
    const user_map = cache.user_maps.get(trec.hrid);
    const should_track = !!hres && should_have_qbt_user(hres.tt_flags, hres.archived_info.on);
    if (!user_map) {
        ilog(
            `[ts] Skipping ${should_track ? "without" : "with"} cursor advance (${should_track ? "employee" : "subc"})`
        );
        return !should_track;
    }

    // Skip update and advance cursor if there is no jobcode mapping and there shouldn't be, and if there should be don't advance the
    // cursor so we can wait for one to show up
    const cont = cache.conts.get(trec.cont_id);
    const jobcode_map = cache.jc_maps.get(trec.cont_id);
    const should_have_jc = !!cont && should_have_active_qbt_jobcode(cont);
    if (!jobcode_map) {
        ilog(
            `[ts] Skipping ${should_have_jc ? "without" : "with"} cursor advance (${should_have_jc ? "jci missing" : "no jci"})`
        );
        return !should_have_jc;
    }

    const do_create = async () => {
        const timesheet = await qbt.create_timesheet({
            user_id: user_map.qbt_id,
            jobcode_id: jobcode_map.qbt_id,
            start: trec.start.toISOString(),
            end: on_the_clock ? "" : trec.end.toISOString(),
            date: trec.date.toISOString().slice(0, 10),
            notes: trec.notes,
            location: OUR_UPDATE_BY,
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
        // We know Want is true here, because we would have early outed above if not.
        // Absent from the prefetch means it was deleted on QBT — drop the stale mapping
        // and recreate. (A real update_timesheet failure now propagates to the caller's
        // per-item catch and floors the cursor, instead of wrongly triggering recreate.)
        const ts = cache.qbt_ts.get(mapping.qbt_id);
        if (!ts) {
            // QBT timesheet is gone either way, so drop the stale mapping; only recreate
            // if the person should still be tracking time in qbt.
            await map_col.deleteOne({ _id: mapping._id });
            if (!should_track) {
                wlog(
                    `[ts] Timesheet ${mapping.qbt_id} gone on qbt and hres ${trec.hrid} should not track - dropped stale mapping ${mapping._id}, not recreating`
                );
                return true;
            }
            wlog(
                `[ts] Timesheet ${mapping.qbt_id} missing on qbt - removed stale mapping ${mapping._id} and recreating`
            );
            await do_create();
        } else {
            const updates: Partial<qbt_timesheet> = {};
            if (!dates_equal(trec.start, ts.start)) updates.start = trec.start.toISOString();
            if (!dates_equal(trec.end, ts.end)) updates.end = !on_the_clock ? trec.end.toISOString() : "";
            if (!dates_equal(trec.date, ts.date)) updates.date = short_date_str(trec.date);
            if (trec.notes !== ts.notes) updates.notes = trec.notes;
            if (jobcode_map.qbt_id !== ts.jobcode_id) updates.jobcode_id = jobcode_map.qbt_id;

            if (Object.keys(updates).length > 0) {
                const updated = await qbt.update_timesheet(ts.id, updates);
                ilog(`[ts] Updated ${get_timesheet_log_str(updated)} with:`, updates);

                // Here we gotta update our mapping last mod as well so that our ingest knows when a timesheet edit is from us
                const qbt_update = {
                    $set: {
                        qbt_modified: new Date(updated.last_modified),
                        last_update: make_ci_now(),
                    },
                };
                await map_col.updateOne({ _id: mapping._id }, qbt_update);
                ilog(`[ts] Updated mapping ${mapping._id} with updated ts last mod ${updated.last_modified}`);
            } else {
                ilog(`[ts] No changes`);
            }
        }
    } else if (want) {
        if (!should_track) {
            wlog(`[ts] Skipping with cursor advance - hres ${trec.hrid} should not be tracking time in qbt`);
            return true;
        }
        await do_create();
    } else {
        ilog(`[ts] No changes`);
    }
    return true;
}

// Processes one batch of changed time_records: prefetches its read cache, runs each
// item, then persists the cursor. Mutates `progress` in place and returns the number
// of items processed. Batches arrive in ascending last_update.on order, so flooring
// the cursor at the earliest unresolved item (via safe_cursor) keeps a per-batch save
// from ever jumping past an item a later batch hasn't reached yet.
async function process_outbound_batch(
    batch: time_record[],
    batch_num: number,
    base: number,
    since: Date,
    progress: cursor_progress,
    qbt: qbt_client
): Promise<void> {
    const cache = await load_outbound_ts_cache(batch, qbt);
    for (let i = 0; i < batch.length; ++i) {
        const trec = batch[i];
        const at = trec.last_update.on;
        ilog(`[ts] Processing update for ${get_time_record_log_str(trec)} (#${base + i + 1}, batch ${batch_num})`);
        try {
            const resolved = await process_time_record_update(trec, qbt, cache);
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
        ilog(`[ts] Outbound cursor advanced to ${latest.toISOString()} (after batch ${batch_num})`);
    }
}

export async function update_timesheets_from_time_recs(qbt: qbt_client): Promise<void> {
    const state = get_sync_state();
    const since = state.timesheets.outbound_last_synced ?? CURSOR_EPOCH;
    ilog(`[ts] Delta sync since: ${since.toISOString()}`);

    // Stream the changed set in ascending last_update.on order and process it in
    // bounded batches instead of one giant toArray(): on the first run `since` is
    // epoch, so the changed set is the entire time_records collection and loading it
    // (plus the per-batch prefetch caches) at once OOMs the heap. The sort requires a
    // Mongo index on {"last_update.on": 1}; without one a large result set blows the
    // server-side sort memory limit. noCursorTimeout keeps the cursor alive across the
    // slow, rate-limited QBT writes of a batch (a full batch can exceed the default
    // 10-minute idle timeout); the for-await closes it on completion or throw.
    const db_cursor = mongo
        .get_trecs()
        .find({ "last_update.on": { $gt: since } }, { noCursorTimeout: true })
        .sort({ "last_update.on": 1 });

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    let batch: time_record[] = [];
    let processed = 0;
    let batch_num = 0;
    let last_ts = 0;

    for await (const trec of db_cursor) {
        // Only cut a batch at a timestamp boundary, never mid-tie. The per-batch save
        // commits the cursor up to the batch's max last_update.on, and resume uses a
        // strict $gt; if equal-timestamp docs were split across a saved boundary, a
        // crash between the two halves would drop the remainder forever. A single
        // timestamp with more than batch_size docs therefore yields one oversized
        // batch — bounded by the tie size, still far below the whole-collection load.
        const at = trec.last_update.on.getTime();
        if (batch.length >= config.outbound_ts_batch_size && at !== last_ts) {
            batch_num++;
            ilog(`[ts] Processing outbound batch ${batch_num} (${batch.length} trecs)`);
            await process_outbound_batch(batch, batch_num, processed, since, progress, qbt);
            processed += batch.length;
            batch = [];
        }
        batch.push(trec);
        last_ts = at;
    }
    if (batch.length > 0) {
        batch_num++;
        ilog(`[ts] Processing outbound batch ${batch_num} (${batch.length} trecs)`);
        await process_outbound_batch(batch, batch_num, processed, since, progress, qbt);
        processed += batch.length;
    }

    if (processed === 0) ilog("[ts] No outbound changes.");
}
