import mongo from "./db";

// Per-collection floor for update_mock_db's incremental QBT pulls.
//
// The floor used to be the newest last_modified already in the mock collection,
// but the dev sync service also writes those collections (mock-created rows and
// mock updates to real rows are stamped with the wall clock at write time). Any
// such write pushed the floor forward without a QBT fetch having covered the gap,
// so a real object modified in between was never pulled — e.g. a user created in
// QBT on Aug 6 was skipped for good once a dev pass stamped rows on Aug 25.
//
// Instead, each update run records the newest last_modified *QBT itself returned*
// for that collection and the next run pulls from there. Only QBT data moves it.
export type mock_update_key = "users" | "jobcodes" | "jobcode_assignments" | "timesheets";

export type mock_update_meta = {
    _id: mock_update_key;
    qbt_last_modified: Date; // newest last_modified among items fetched from QBT so far
    updated: Date; // when this floor was last advanced
};

export async function get_update_floor(key: mock_update_key): Promise<Date | null> {
    const doc = await mongo.get_mock_update_meta().findOne({ _id: key });
    return doc?.qbt_last_modified ?? null;
}

// Advance the floor to the newest last_modified among the items QBT returned. A run
// that fetched nothing leaves it alone; a stale meta (older than what was fetched)
// is simply overwritten.
export async function advance_update_floor(key: mock_update_key, items: { last_modified: string }[]): Promise<void> {
    let max: Date | null = null;
    for (const it of items) {
        const d = new Date(it.last_modified);
        if (Number.isNaN(d.getTime())) continue;
        if (!max || d > max) max = d;
    }
    if (!max) return;
    const cur = await get_update_floor(key);
    if (cur && cur >= max) return;
    await mongo
        .get_mock_update_meta()
        .updateOne({ _id: key }, { $set: { qbt_last_modified: max, updated: new Date() } }, { upsert: true });
}

// Reset the floor to exactly what a full snapshot holds. seed_mock_db calls this after
// wiping and re-copying a collection, so the next update continues from the snapshot
// rather than re-fetching everything (no floor means a full fetch).
export async function set_update_floor(key: mock_update_key, items: { last_modified: string }[]): Promise<void> {
    await mongo.get_mock_update_meta().deleteOne({ _id: key });
    await advance_update_floor(key, items);
}
