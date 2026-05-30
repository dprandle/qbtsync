import dotenv from "dotenv";
dotenv.config();

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
    qbt_env: (process.env["QBT_ENV"] ?? "prod") as "dev" | "prod",
    timesheet_sync_interval_ms: optional_int("TIMESHEET_SYNC_INTERVAL_MS", 60_000),
    user_sync_interval_ms: optional_int("USER_SYNC_INTERVAL_MS", 60_000),
    jobcode_sync_interval_ms: optional_int("JOBCODE_SYNC_INTERVAL_MS", 60_000),
};
