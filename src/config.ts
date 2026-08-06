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
    // The full qbt-object-map cleanup is a heavy, rate-limited full scan — a
    // reconciliation safety net for hard-deletes the delta loops structurally can't
    // see. It stays in the single sync loop (so it never races the other passes over
    // the shared map/QBT, and shares the one rate limiter), but is confined to a
    // low-traffic window so its long scan can't stall the live sync mid-day. The
    // window is the scheduler: it runs once per window opening (drift-free, gated on
    // the persisted last_run). Times are the SERVER's local timezone. Day is
    // 0=Sunday..6=Saturday, or -1 for any day (a daily window). The window spans
    // [start_hour, start_hour + window_hours) and must not cross midnight
    // (start_hour + window_hours <= 24). Make window_hours comfortably larger than one
    // sync tick so a tick reliably lands inside it. Default: Sundays 08:00–09:00 (considering UTC).
    mapping_cleanup_day: optional_int("MAPPING_CLEANUP_DAY", 0),
    mapping_cleanup_start_hour: optional_int("MAPPING_CLEANUP_START_HOUR", 8),
    mapping_cleanup_window_hours: optional_int("MAPPING_CLEANUP_WINDOW_HOURS", 1),
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
    // Floored-cursor email alerts (SendGrid). A cursor "floored" on the same item for
    // this many consecutive passes means the sync is wedged waiting on something that
    // won't resolve by itself (unmapped user/jobcode, repeated per-item error) and is
    // re-scanning its whole changed set every pass. Alerts are disabled unless both
    // the API key and a recipient are set; the from-address must be a verified
    // SendGrid sender. While the same item stays blocking, re-alerts are throttled to
    // once per CURSOR_FLOOR_REALERT_HOURS.
    sendgrid_api_key: process.env["SENDGRID_API_KEY"] ?? "",
    alert_email_to: process.env["ALERT_EMAIL_TO"] ?? "",
    alert_email_from: process.env["ALERT_EMAIL_FROM"] ?? "no-reply@zetrick.com",
    cursor_floor_alert_passes: optional_int("CURSOR_FLOOR_ALERT_PASSES", 10),
    cursor_floor_realert_hours: optional_int("CURSOR_FLOOR_REALERT_HOURS", 24),
};
