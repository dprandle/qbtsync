import "./global_setup";
import { config } from "./config";
import mongo from "./db";
import { reset_sync_state, ensure_state_file_writable } from "./sync_state";
import { update_time_recs_from_timesheets, update_timesheets_from_time_recs } from "./sync_timesheets";
import { update_users_from_hres, bootstrap_users } from "./sync_users";
import { update_jobcodes_from_contracts, bootstrap_jobcodes } from "./sync_jobcodes";
import { qbt_api_client } from "./qbt_client";
import { qbt_mock_client } from "./qbt_mock_client";
import { qbt_client } from "./qbt_client_interface";

const do_reset = process.argv.includes("--reset");

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function run_timesheet_loop(qbt: qbt_client): Promise<void> {
    ilog(`[ts] Starting sync loop (inbound: ${config.timesheet_sync_interval_ms}ms)`);
    while (true) {
        try {
            await update_time_recs_from_timesheets(qbt);
            await update_timesheets_from_time_recs(qbt);
        } catch (err) {
            elog("[ts] Loop error:", err);
        }
        await sleep(config.timesheet_sync_interval_ms);
    }
}

// Users and jobcodes run in a single sequential pass rather than as concurrent
// loops. They share the qbt object map and reconcile the same jobcode-assignment
// records from opposite directions, so running them one at a time keeps that
// shared state deterministic and avoids interleaving races. User changes
// (archive, time-tracking toggle) only bump the hresource doc, so user-side
// reconciliation is still required alongside the jobcode-side pass.
async function run_entity_loop(qbt: qbt_client): Promise<void> {
    ilog(`[entity] Starting users+jobcodes sync loop (interval: ${config.entity_sync_interval_ms}ms)`);
    while (true) {
        try {
            await update_users_from_hres(qbt);
            await update_jobcodes_from_contracts(qbt);
        } catch (err) {
            elog("[entity] Loop error:", err);
        }
        await sleep(config.entity_sync_interval_ms);
    }
}

async function main(): Promise<void> {
    // Fail fast if the configured state path can't be created/written, before
    // we connect to Mongo or run any sync work.
    ensure_state_file_writable();

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
        await bootstrap_jobcodes(qbt);
        await bootstrap_users(qbt);

        // The first inbound timesheet pass (cursor = CURSOR_EPOCH) performs the
        // historical backfill bounded by config.timesheet_start_date; no separate
        // full-import step is needed.
        ilog("[startup] Bootstraps complete — starting periodic loops.");
        await Promise.all([run_timesheet_loop(qbt), run_entity_loop(qbt)]);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("Fatal error:", err);
    process.exit(1);
});
