import { randomUUID } from "crypto";
import { save_timesheet_state, load_sync_state } from "./sync_state";
import { get_trec_collection, get_qbt_map_collection } from "./db";
import { qbt_timesheet, time_record, QBT_ACTIVE } from "./types";
import { qbt_client } from "./qbt_client_interface";
import { INVALID_DATETIME } from "./assignments";

const SCHEMA_VERSION = 1;

function timesheet_to_time_record(ts: qbt_timesheet, hres_id: string, cont_id: string): time_record {
  const now = new Date();
  return {
    _id: randomUUID(),
    custom_params: {},
    archived_info: {by: "", on: INVALID_DATETIME},
    last_update: { by: "qbtsync", on: now },
    created: { by: "qbtsync", on: now },
    schema_version: SCHEMA_VERSION,
    hrid: hres_id,
    cont_id: cont_id,
    notes: ts.notes,
    start: new Date(ts.start),
    end: new Date(ts.end),
    date: new Date(ts.date),
  };
}

function dates_approx_equal(a: Date, b: string): boolean {
    // Compare within 1 second to avoid floating point / rounding issues
    return Math.abs(a.getTime() - new Date(b).getTime()) < 1000;
}

// Returns true if the timesheet was processed (or is already up to date), false if
// it was skipped because the QBT user/jobcode is not mapped yet and should be retried.
async function upsert_timesheet(ts: qbt_timesheet, qbt: qbt_client): Promise<boolean> {
    const map_col = get_qbt_map_collection();
    const incoming_modified = new Date(ts.last_modified);

    const mapping = await map_col.findOne({ type: "timesheet", qbt_id: ts.id });

    if (mapping) {
        if (incoming_modified <= mapping.qbt_modified) {
            return true; // already up to date
        }

        const rec = await get_trec_collection().findOne({ _id: mapping.our_id });
        if (!rec) {
            // Mapping exists but record is gone — just update qbt_modified
            await map_col.updateOne(
                { type: "timesheet", qbt_id: ts.id },
                { $set: { qbt_modified: incoming_modified, our_updated_at: new Date() } }
            );
            return true;
        }

        const changed =
            ts.notes !== rec.notes ||
            !dates_approx_equal(rec.start, ts.start) ||
            !dates_approx_equal(rec.end, ts.end) ||
            !dates_approx_equal(rec.date, ts.date);

        if (changed) {
            // QBT-side change detected; our time_record is authoritative — push it back
            const reverted = await qbt.update_timesheet(ts.id, {
                notes: rec.notes,
                start: rec.start.toISOString(),
                end: rec.end.toISOString(),
                date: rec.date.toISOString().slice(0, 10),
            });
            await map_col.updateOne(
                { type: "timesheet", qbt_id: ts.id },
                { $set: { qbt_modified: new Date(reverted.last_modified), our_updated_at: new Date() } }
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

        const rec = timesheet_to_time_record(ts, user_map.our_id, jobcode_map.our_id);
        await get_trec_collection().insertOne(rec);
        await map_col.insertOne({
            _id: randomUUID(),
            qbt_id: ts.id,
            our_id: rec._id,
            type: "timesheet",
            qbt_status: QBT_ACTIVE,
            qbt_modified: incoming_modified,
            our_updated_at: new Date(),
        });
        return true;
    }
}

type inbound_progress = {
    // Highest last_modified among timesheets that were resolved (created/updated).
    latest_resolved: Date;
    // Lowest last_modified among timesheets skipped for missing user/jobcode mappings.
    earliest_unresolved: Date | null;
};

async function process_inbound_page(
    timesheets: qbt_timesheet[],
    progress: inbound_progress,
    qbt: qbt_client
): Promise<inbound_progress> {
    let { latest_resolved, earliest_unresolved } = progress;
    for (const ts of timesheets) {
        const mod = new Date(ts.last_modified);
        const resolved = await upsert_timesheet(ts, qbt);
        if (resolved) {
            if (mod > latest_resolved) latest_resolved = mod;
        } else if (!earliest_unresolved || mod < earliest_unresolved) {
            earliest_unresolved = mod;
        }
    }
    return { latest_resolved, earliest_unresolved };
}

// The cursor must never reach or pass a skipped timesheet, so the next pass
// re-fetches it once its user/jobcode mappings exist. Floor it at `since` so a
// skip at/below the current cursor never moves it backwards.
function safe_cursor(progress: inbound_progress, since: Date): Date {
    let cursor = progress.latest_resolved;
    if (progress.earliest_unresolved) {
        const cap = new Date(progress.earliest_unresolved.getTime() - 1);
        if (cap < cursor) cursor = cap;
    }
    return cursor < since ? since : cursor;
}


export async function full_import(qbt: qbt_client): Promise<void> {
    console.log("[timesheets] Starting full import...");
    const state = load_sync_state();
    let page = state.timesheets.full_import_page;
    const since = state.timesheets.last_synced ?? new Date(0);
    let progress: inbound_progress = { latest_resolved: since, earliest_unresolved: null };

    while (true) {
        console.log(`[timesheets] Fetching page ${page}...`);
        const { timesheets, more } = await qbt.fetch_timesheets({ page });

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
    let progress: inbound_progress = { latest_resolved: modified_since, earliest_unresolved: null };

    while (true) {
        const { timesheets, more } = await qbt.fetch_timesheets({ modified_since, page });

        if (timesheets.length === 0) break;

        progress = await process_inbound_page(timesheets, progress, qbt);

        if (!more) break;
        page++;
    }

    const latest_modified = safe_cursor(progress, modified_since);
    if (latest_modified > modified_since) {
        await save_timesheet_state({ last_synced: latest_modified });
        console.log(`[timesheets] Inbound cursor advanced to ${latest_modified.toISOString()}`);
    } else {
        console.log("[timesheets] No new inbound timesheets.");
    }
}

export async function outbound_sync(qbt: qbt_client): Promise<void> {
    const state = load_sync_state();
    const since = state.timesheets.outbound_last_synced ?? new Date(0);

    const candidates = await get_trec_collection()
        .find({ updated_at: { $gt: since } })
        .toArray();

    if (candidates.length === 0) return;

    console.log(`[timesheets] Outbound sync: ${candidates.length} candidate(s)`);

    const map_col = get_qbt_map_collection();
    let latest_updated = since;

    for (const rec of candidates) {
        try {
            const mapping = await map_col.findOne({ type: "timesheet", our_id: rec._id });

            if (mapping) {
                const our_updated_at = mapping.our_updated_at ?? new Date(0);
                if (rec.last_update.on > our_updated_at) {
                    // Desktop-originated edit — push to QBT
                    const updated = await qbt.update_timesheet(mapping.qbt_id, {
                        notes: rec.notes,
                        start: rec.start.toISOString(),
                        end: rec.end.toISOString(),
                        date: rec.date.toISOString().slice(0, 10),
                    });
                    const now = new Date();
                    await map_col.updateOne(
                        { type: "timesheet", our_id: rec._id },
                        { $set: { qbt_modified: new Date(updated.last_modified), our_updated_at: now } }
                    );
                    console.log(`[timesheets] Pushed edit for time_record ${rec._id} to QBT id ${mapping.qbt_id}`);
                }
            } else {
                // No mapping: time_record was created directly in UberMail
                // Requires both user and jobcode mappings to exist in QBT
                if (!rec.hrid || !rec.cont_id) continue;

                const user_map = await map_col.findOne({ type: "user", our_id: rec.hrid });
                const jobcode_map = await map_col.findOne({ type: "jobcode", our_id: rec.cont_id });

                if (!user_map || !jobcode_map) {
                    // Not synced yet; will retry on next pass after user/jobcode syncs run
                    continue;
                }

                const created = await qbt.create_timesheet({
                    user_id: user_map.qbt_id,
                    jobcode_id: jobcode_map.qbt_id,
                    start: rec.start.toISOString(),
                    end: rec.end.toISOString(),
                    date: rec.date.toISOString().slice(0, 10),
                    type: "regular",
                    notes: rec.notes,
                });
                const now = new Date();
                await map_col.insertOne({
                    _id: randomUUID(),
                    qbt_id: created.id,
                    our_id: rec._id,
                    type: "timesheet",
                    qbt_status: QBT_ACTIVE,
                    qbt_modified: new Date(created.last_modified),
                    our_updated_at: now,
                });
                console.log(`[timesheets] Created QBT timesheet ${created.id} for time_record ${rec._id}`);
            }
        } catch (err) {
            console.error(`[timesheets] Outbound error for time_record ${rec._id}:`, err);
        }

        if (rec.last_update.on > latest_updated) latest_updated = rec.last_update.on;
    }

    if (latest_updated > since) {
        save_timesheet_state({ outbound_last_synced: latest_updated });
    }
}
