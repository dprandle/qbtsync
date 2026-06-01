import "./global_setup"
import { config } from "./config";
import mongo from "./db";
import { load_sync_state, reset_sync_state } from "./sync_state";
import { full_import, incremental_sync, outbound_sync } from "./sync_timesheets";
import { sync_users, bootstrap_users } from "./sync_users";
import { sync_jobcodes, bootstrap_jobcodes } from "./sync_jobcodes";
import { qbt_api_client } from "./qbt_client";
import { qbt_mock_client } from "./qbt_mock_client";
import { qbt_client } from "./qbt_client_interface";

const force_full_import = process.argv.includes("--full-import");
const do_reset = process.argv.includes("--reset");

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run_timesheet_loop(qbt: qbt_client): Promise<void> {
    ilog(`[ts] Starting sync loop (inbound: ${config.timesheet_sync_interval_ms}ms)`);
    while (true) {
        try {
            await incremental_sync(qbt);
            await outbound_sync(qbt);
        } catch (err) {
            elog("[ts] Loop error:", err);
        }
        await sleep(config.timesheet_sync_interval_ms);
    }
}

async function run_user_loop(qbt: qbt_client): Promise<void> {
    ilog(`[usi] Starting sync loop (interval: ${config.user_sync_interval_ms}ms)`);
    while (true) {
        try {
            await sync_users(qbt);
        } catch (err) {
            elog("[usi] Loop error:", err);
        }
        await sleep(config.user_sync_interval_ms);
    }
}

async function run_jobcode_loop(qbt: qbt_client): Promise<void> {
    ilog(`[jc] Starting sync loop (interval: ${config.jobcode_sync_interval_ms}ms)`);
    while (true) {
        try {
            await sync_jobcodes(qbt);
        } catch (err) {
            elog("[jc] Loop error:", err);
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
            ilog("[dev] QBT_ENV=dev — using mock QBT backed by MongoDB (run 'npm run seed_mock_db' to populate it)");
            qbt = new qbt_mock_client();
        } else {
            qbt = new qbt_api_client();
        }

        // Bootstrap must fully complete for both users and jobcodes before any
        // sync runs: jobcode-assignment reconciliation (in both the user and
        // jobcode syncs) reads the user<->jobcode mappings the other bootstrap
        // produces, so a partial bootstrap would reconcile against an
        // incomplete map.
        ilog("[startup] Running bootstraps before any sync...");
        await Promise.all([bootstrap_users(qbt), bootstrap_jobcodes(qbt)]);

        // Time records reverse-map each QBT timesheet's user/jobcode through
        // qbt_object_map, so those mappings must exist before the timesheet
        // import runs. Sync users and jobcodes first, then do the full timesheet
        // import, then start all the periodic loops.
        ilog("[startup] Syncing users and jobcodes before timesheets...");
        await Promise.all([sync_users(qbt), sync_jobcodes(qbt)]);

        const state = load_sync_state();
        if (force_full_import || !state.timesheets.full_import_complete) {
            await full_import(qbt);
        }

        ilog("[startup] Initial sync complete — starting periodic loops.");
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
    elog("Fatal error:", err);
    process.exit(1);
});
