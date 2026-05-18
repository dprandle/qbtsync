import dotenv from "dotenv";
dotenv.config();

function required(key: string): string {
    const val = process.env[key];
    if (!val) throw new Error(`Missing required env var: ${key}`);
    return val;
}

export const config = {
    mongo_uri: required("MONGODB_URI"),
    mongo_db_name: required("MONGODB_DB_NAME"),
    qbt_access_token: required("QBT_ACCESS_TOKEN"),
    sync_interval_ms: parseInt(process.env["SYNC_INTERVAL_MS"] ?? "60000", 10),
};
