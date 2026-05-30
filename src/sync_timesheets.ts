import { randomUUID } from "crypto";
import { save_timesheet_state, load_sync_state } from "./sync_state";
import { get_trec_collection, get_qbt_map_collection } from "./db";
import { qbt_timesheet, time_record, QBT_ACTIVE } from "./types";
import { qbt_client } from "./qbt_client_interface";

function timesheet_to_time_record(ts: qbt_timesheet): time_record {
    const now = new Date();
    return {
        _id: randomUUID(),
        hrid: "",
        cont_id: "",
        notes: ts.notes,
        start: new Date(ts.start),
        end: new Date(ts.end),
        date: new Date(ts.date),
        created_at: now,
        updated_at: now,
    };
}

function dates_approx_equal(a: Date, b: string): boolean {
    // Compare within 1 second to avoid floating point / rounding issues
    return Math.abs(a.getTime() - new Date(b).getTime()) < 1000;
}

async function upsert_timesheet(ts: qbt_timesheet, qbt: qbt_client): Promise<void> {
    const map_col = get_qbt_map_collection();
    const incoming_modified = new Date(ts.last_modified);

    const mapping = await map_col.findOne({ type: "timesheet", qbt_id: ts.id });

    if (mapping) {
        if (incoming_modified <= mapping.qbt_modified) {
            return; // already up to date
        }

        const rec = await get_trec_collection().findOne({ _id: mapping.our_id });
        if (!rec) {
            // Mapping exists but record is gone — just update qbt_modified
            await map_col.updateOne(
                { type: "timesheet", qbt_id: ts.id },
                { $set: { qbt_modified: incoming_modified, our_updated_at: new Date() } }
            );
            return;
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
    } else {
        // New timesheet from QBT — create a time_record and mapping
        const rec = timesheet_to_time_record(ts);
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
    }
}

async function process_inbound_page(timesheets: qbt_timesheet[], latest_modified: Date, qbt: qbt_client): Promise<Date> {
    for (const ts of timesheets) {
        await upsert_timesheet(ts, qbt);
        const mod = new Date(ts.last_modified);
        if (mod > latest_modified) latest_modified = mod;
    }
    return latest_modified;
}


export async function full_import(qbt: qbt_client): Promise<void> {
    console.log("[timesheets] Starting full import...");
    const state = load_sync_state();
    let page = state.timesheets.full_import_page;
    let latest_modified = state.timesheets.last_synced ?? new Date(0);

    while (true) {
        console.log(`[timesheets] Fetching page ${page}...`);
        const { timesheets, more } = await qbt.fetch_timesheets({ page });

        if (timesheets.length === 0) break;

        latest_modified = await process_inbound_page(timesheets, latest_modified, qbt);

        save_timesheet_state({ full_import_page: page, last_synced: latest_modified });

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
    let latest_modified = modified_since;

    while (true) {
        const { timesheets, more } = await qbt.fetch_timesheets({ modified_since, page });

        if (timesheets.length === 0) break;

        latest_modified = await process_inbound_page(timesheets, latest_modified, qbt);

        if (!more) break;
        page++;
    }

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
                if (rec.updated_at > our_updated_at) {
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

        if (rec.updated_at > latest_updated) latest_updated = rec.updated_at;
    }

    if (latest_updated > since) {
        await save_timesheet_state({ outbound_last_synced: latest_updated });
    }
}
