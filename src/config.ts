function required(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
}

function optional_int(key: string, default_val: number): number {
    return parseInt(process.env[key] ?? String(default_val), 10);
}

export const config = {
    mongo_uri: required("MONGODB_URI"),
    mongo_db_name: required("MONGODB_DB_NAME"),
    mock_qbt_db_name: process.env["MOCK_QBT_DB_NAME"] ?? "mock_qbt",
    qbt_access_token: required("QBT_ACCESS_TOKEN"),
    qbt_env: (process.env["QBT_ENV"] ?? "dev") as "dev" | "prod",
    timesheet_start_date: process.env["TIMESHEET_START_DATE"] ?? "2024-01-01",
    sync_state_file: process.env["SYNC_STATE_FILE"] ?? "./sync_state.json",
    timesheet_sync_interval_ms: optional_int("TIMESHEET_SYNC_INTERVAL_MS", 60000),
    // The inbound timesheet cursor advances to the moment a scan *started*, which
    // already covers edits landing mid-scan (they're stamped >= scan start). This
    // pad only absorbs clock skew between our host and QBT's clock (last_modified is
    // QBT-stamped) plus a little for timestamp granularity. Keep it small relative to
    // the sync interval: an edit gets re-fetched across ~(pad + interval)/interval
    // runs, so an oversized pad just wastes (idempotent) re-fetches.
    qbt_clock_skew_pad_ms: optional_int("QBT_CLOCK_SKEW_PAD_MS", 5000),
    // The sync runs as one sequential loop whose base tick is the timesheet
    // interval above. Users+jobcodes are reconciled every Nth tick rather than on
    // their own clock: they share the qbt object map and reconcile the same
    // assignment records as the timesheet pass, so serializing everything onto one
    // tick keeps that shared state deterministic and free of interleaving. N=1
    // reconciles entities on every tick (the previous equal-interval behavior).
    entity_sync_every_n_ticks: optional_int("ENTITY_SYNC_EVERY_N_TICKS", 1),
    // How often the full qbt-object-map cleanup runs (wall-clock, checked against
    // the persisted last_run so it survives restarts). This is a reconciliation
    // safety net for hard-deletes the delta loops structurally can't see, so it's
    // meant to run rarely. Default: 7 days.
    mapping_cleanup_interval_ms: optional_int("MAPPING_CLEANUP_INTERVAL_MS", 7 * 24 * 60 * 60 * 1000),
    // QBT's live API rejects (HTTP 429) more than a fixed number of requests per
    // rolling window (300 / 5 min on our plan). We self-throttle every outbound
    // QBT request below that ceiling; the default leaves headroom for clock skew
    // and any out-of-band calls. Applied across all four HTTP verbs.
    qbt_rate_limit_max_requests: optional_int("QBT_RATE_LIMIT_MAX_REQUESTS", 260),
    qbt_rate_limit_window_ms: optional_int("QBT_RATE_LIMIT_WINDOW_MS", 5 * 60 * 1000),
    // Outbound timesheet sync processes changed time_records in batches of this size
    // rather than loading the whole changed set at once. On the first run the cursor
    // is at epoch, so the changed set is the entire collection — materializing it (and
    // its prefetch caches) in one array OOMs the heap. Batching caps memory and lets
    // the cursor advance per batch so a crash resumes near where it stopped. Requires
    // a Mongo index on time_records {"last_update.on": 1} (the batches are sorted by it).
    outbound_ts_batch_size: optional_int("OUTBOUND_TS_BATCH_SIZE", 5000),
};
