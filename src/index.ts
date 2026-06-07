import "./global_setup";
import { config } from "./config";
import mongo from "./db";
import {
    reset_sync_state,
    ensure_state_file_writable,
    cleanup_due,
    save_cleanup_state,
    get_sync_state,
} from "./sync_state";
import { run_qbt_mapping_cleanup } from "./qbt_mapping_cleanup";
import { update_time_recs_from_timesheets, update_timesheets_from_time_recs } from "./sync_timesheets";
import { update_users_from_hres } from "./sync_users";
import { update_jobcodes_from_contracts } from "./sync_jobcodes";
import { qbt_api_client } from "./qbt_client";
import { qbt_mock_client } from "./qbt_mock_client";
import { qbt_client } from "./qbt_client_interface";
import { start_invite_server } from "./invite_server";

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

    // Bootstrap is a separate, one-time operation (npm run bootstrap) that matches
    // existing QBT jobcodes/users to our contracts/hresources. The sync service
    // assumes those mappings exist: without them it would treat every entity as
    // new and create duplicate QBT objects. Refuse to start until both bootstraps
    // have completed (a --reset clears these flags, forcing a re-bootstrap).
    const state = get_sync_state();
    if (!state.jobcodes.bootstrap_complete || !state.users.bootstrap_complete) {
        elog("[startup] Bootstrap not complete — run `npm run bootstrap` before starting the sync service.");
        process.exit(1);
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

        // Serve invite requests from the same process: it shares this mongo
        // connection and qbt client, and the handler only reads the qbt object
        // map (never writes it), so it can't race the sync loop's map updates.
        const app = await start_invite_server(qbt);

        // systemd sends SIGTERM on `systemctl stop` (and SIGINT on Ctrl-C in a
        // foreground run). Drain in-flight invite requests and close connections
        // cleanly instead of dropping them on a hard exit. The sync loop never
        // returns, so this handler — not the finally below — is the normal exit
        // path. A watchdog force-exits if the clean shutdown stalls (e.g. a hung
        // request), so we don't run past systemd's TimeoutStopSec.
        let shutting_down = false;
        const shutdown = async (sig: string): Promise<void> => {
            if (shutting_down) return;
            shutting_down = true;
            ilog(`[shutdown] ${sig} received — closing invite server and MongoDB connection`);
            const force = setTimeout(() => {
                elog("[shutdown] Clean shutdown timed out — forcing exit");
                process.exit(1);
            }, 10_000);
            force.unref();
            try {
                await app.close();
                await mongo.disconnect();
                ilog("[shutdown] Clean shutdown complete");
                process.exit(0);
            } catch (err) {
                elog("[shutdown] Error during shutdown:", err);
                process.exit(1);
            }
        };
        for (const sig of ["SIGINT", "SIGTERM"] as const) {
            process.on(sig, () => void shutdown(sig));
        }

        // The first inbound timesheet pass (cursor = CURSOR_EPOCH) performs the
        // historical backfill bounded by config.timesheet_start_date; no separate
        // full-import step is needed.
        ilog("[startup] Starting periodic sync loop.");
        await run_sync_loop(qbt);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("Fatal error:", err);
    process.exit(1);
});
