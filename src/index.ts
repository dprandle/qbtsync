import { connect, disconnect, load_sync_state } from "./db";
import { full_import, incremental_sync } from "./sync";
import { config } from "./config";

const force_full_import = process.argv.includes("--full-import");

async function main(): Promise<void> {
    await connect();

    try {
        const state = await load_sync_state();

        if (force_full_import || !state.full_import_complete) {
            await full_import();
        }

        console.log(`Starting incremental sync loop (interval: ${config.sync_interval_ms}ms)`);
        while (true) {
            try {
                await incremental_sync();
            } catch (err) {
                console.error("Incremental sync error:", err);
            }
            await sleep(config.sync_interval_ms);
        }
    } finally {
        await disconnect();
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
});
