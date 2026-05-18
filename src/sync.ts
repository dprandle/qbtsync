import { randomUUID } from "crypto";
import { load_sync_state, save_sync_state, time_records_col, qbt_object_map_col } from "./db";
import { fetch_timesheets } from "./qbt_client";
import { qbt_timesheet, time_record } from "./types";

// hrid and cont_id are left blank — filled in once qbt_user_map and qbt_jobcode_map
// entries exist for this timesheet's user_id and jobcode_id.
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

async function upsert_timesheet(ts: qbt_timesheet): Promise<void> {
    const map_col = qbt_object_map_col();
    const incoming_modified = new Date(ts.last_modified);

    const mapping = await map_col.findOne({ type: "timesheet", qbt_id: ts.id });

    if (mapping) {
        if (incoming_modified <= mapping.qbt_modified) {
            return; // already up to date
        }
        await time_records_col().updateOne(
            { _id: mapping.our_id },
            {
                $set: {
                    notes: ts.notes,
                    start: new Date(ts.start),
                    end: new Date(ts.end),
                    date: new Date(ts.date),
                    updated_at: new Date(),
                },
            }
        );
        await map_col.updateOne(
            { type: "timesheet", qbt_id: ts.id },
            { $set: { qbt_modified: incoming_modified } }
        );
    } else {
        const rec = timesheet_to_time_record(ts);
        await time_records_col().insertOne(rec);
        await map_col.insertOne({
            qbt_id: ts.id,
            our_id: rec._id,
            type: "timesheet",
            qbt_modified: incoming_modified,
        });
    }
}

async function process_page(timesheets: qbt_timesheet[], latest_modified: Date): Promise<Date> {
    for (const ts of timesheets) {
        await upsert_timesheet(ts);
        const mod = new Date(ts.last_modified);
        if (mod > latest_modified) latest_modified = mod;
    }
    return latest_modified;
}

export async function full_import(): Promise<void> {
    console.log("Starting full import...");
    const state = await load_sync_state();
    let page = state.full_import_page;
    let latest_modified = state.last_synced ?? new Date(0);

    while (true) {
        console.log(`Fetching page ${page}...`);
        const { timesheets, more } = await fetch_timesheets({ page });

        if (timesheets.length === 0) break;

        latest_modified = await process_page(timesheets, latest_modified);

        // Save progress after each page so a crash can resume here
        await save_sync_state({ full_import_page: page, last_synced: latest_modified });

        if (!more) break;
        page++;
    }

    await save_sync_state({ full_import_complete: true, full_import_page: 1 });
    console.log("Full import complete.");
}

export async function incremental_sync(): Promise<void> {
    const state = await load_sync_state();
    const modified_since = state.last_synced ?? new Date(0);

    console.log(`Incremental sync since ${modified_since.toISOString()}`);

    let page = 1;
    let latest_modified = modified_since;

    while (true) {
        const { timesheets, more } = await fetch_timesheets({ modified_since, page });

        if (timesheets.length === 0) break;

        latest_modified = await process_page(timesheets, latest_modified);

        if (!more) break;
        page++;
    }

    // Only advance the cursor if we actually saw new data
    if (latest_modified > modified_since) {
        await save_sync_state({ last_synced: latest_modified });
        console.log(`Cursor advanced to ${latest_modified.toISOString()}`);
    } else {
        console.log("No new timesheets.");
    }
}
