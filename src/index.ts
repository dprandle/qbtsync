import "./global_setup";
import { config } from "./config";
import mongo from "./db";
import { reset_sync_state, ensure_state_file_writable, cleanup_due, save_cleanup_state } from "./sync_state";
import { run_qbt_mapping_cleanup } from "./qbt_mapping_cleanup";
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

// One inbound+outbound timesheet pass. Inbound first so any new QBT-side
// timesheets are ingested before we push our changes back out.
async function sync_timesheets_once(qbt: qbt_client): Promise<void> {
    await update_time_recs_from_timesheets(qbt);
    await update_timesheets_from_time_recs(qbt);
}

// One users+jobcodes reconciliation pass. They share the qbt object map and
// reconcile the same jobcode-assignment records from opposite directions, so
// running them one at a time keeps that shared state deterministic and avoids
// interleaving races. User changes (archive, time-tracking toggle) only bump the
// hresource doc, so user-side reconciliation is still required alongside the
// jobcode-side pass.
async function sync_entities_once(qbt: qbt_client): Promise<void> {
    await update_users_from_hres(qbt);
    await update_jobcodes_from_contracts(qbt);
}

// Everything runs as one sequential loop rather than as concurrent loops. Node is
// single-threaded, so the old Promise.all loops never ran in parallel — they only
// interleaved at await points, which is exactly what made the shared qbt-object-map
// access racy. Serializing onto one tick removes those interleavings, guarantees
// entities are reconciled before the timesheet pass that consumes their mappings,
// and (once added) lets the cleanup pass run with the other work provably paused.
// The base tick is the timesheet interval; entities run every Nth tick.
async function run_sync_loop(qbt: qbt_client): Promise<void> {
    ilog(
        `[sync] Starting sync loop (tick: ${config.timesheet_sync_interval_ms}ms, entities every ${config.entity_sync_every_n_ticks} tick(s))`
    );
    let tick = 0;
    while (true) {
        if (tick % config.entity_sync_every_n_ticks === 0) {
            try {
                await sync_entities_once(qbt);
            } catch (err) {
                elog("[entity] Pass error:", err);
            }
        }
        try {
            await sync_timesheets_once(qbt);
        } catch (err) {
            elog("[ts] Pass error:", err);
        }
        // Cleanup runs last, with the other passes provably idle (single loop), and
        // only every config.mapping_cleanup_interval_ms. last_run is stamped only on a
        // clean completion, so an error retries next tick rather than waiting a full
        // interval; per-batch failures inside the pass are logged and don't throw.
        if (cleanup_due(new Date())) {
            try {
                await run_qbt_mapping_cleanup(qbt);
                save_cleanup_state({ last_run: new Date() });
            } catch (err) {
                elog("[cleanup] Pass error:", err);
            }
        }
        tick++;
        await sleep(config.timesheet_sync_interval_ms);
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
        ilog("[startup] Bootstraps complete — starting periodic sync loop.");
        await run_sync_loop(qbt);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("Fatal error:", err);
    process.exit(1);
});
