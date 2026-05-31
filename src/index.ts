import mongo from "./db";
import { load_sync_state, reset_sync_state } from "./sync_state";
import { full_import, incremental_sync, outbound_sync } from "./sync_timesheets";
import { sync_users } from "./sync_users";
import { sync_jobcodes } from "./sync_jobcodes";
import { qbt_api_client } from "./qbt_client";
import { qbt_mock_client } from "./qbt_mock_client";
import { qbt_client } from "./qbt_client_interface";
import { config } from "./config";

const force_full_import = process.argv.includes("--full-import");
const do_reset = process.argv.includes("--reset");

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run_timesheet_loop(qbt: qbt_client): Promise<void> {
    const state = load_sync_state();
    if (force_full_import || !state.timesheets.full_import_complete) {
        await full_import(qbt);
    }

    console.log(`[timesheets] Starting sync loop (inbound: ${config.timesheet_sync_interval_ms}ms)`);
    while (true) {
        try {
            await incremental_sync(qbt);
            await outbound_sync(qbt);
        } catch (err) {
            console.error("[timesheets] Loop error:", err);
        }
        await sleep(config.timesheet_sync_interval_ms);
    }
}

async function run_user_loop(qbt: qbt_client): Promise<void> {
    console.log(`[users] Starting sync loop (interval: ${config.user_sync_interval_ms}ms)`);
    while (true) {
        try {
            await sync_users(qbt);
        } catch (err) {
            console.error("[users] Loop error:", err);
        }
        await sleep(config.user_sync_interval_ms);
    }
}

async function run_jobcode_loop(qbt: qbt_client): Promise<void> {
    console.log(`[jobcodes] Starting sync loop (interval: ${config.jobcode_sync_interval_ms}ms)`);
    while (true) {
        try {
            await sync_jobcodes(qbt);
        } catch (err) {
            console.error("[jobcodes] Loop error:", err);
        }
        await sleep(config.jobcode_sync_interval_ms);
    }
}

async function main(): Promise<void> {
    if (do_reset) {
        reset_sync_state();
        process.exit(0);
    }

    await mongo.connect();

    try {
        let qbt: qbt_client;
        if (config.qbt_env === "dev") {
            console.log("[dev] QBT_ENV=dev — using mock QBT backed by MongoDB (run 'npm run seed_mock_db' to populate it)");
            qbt = new qbt_mock_client();
        } else {
            qbt = new qbt_api_client();
        }

        await Promise.all([
            run_timesheet_loop(qbt),
            run_user_loop(qbt),
            run_jobcode_loop(qbt),
        ]);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
