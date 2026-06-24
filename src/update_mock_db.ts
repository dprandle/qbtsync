import "./global_setup";
import { Collection, AnyBulkWriteOperation } from "mongodb";
import mongo from "./db";
import { qbt_api_client } from "./qbt_client";
import { to_mock_doc } from "./qbt_mock_client";

// Most-recent last_modified instant stored in a mock collection. last_modified is an
// ISO-8601 string, but stored values carry different zone offsets (mock writes use the
// "Z" form, QBT live emits numeric offsets), so a lexical max would be wrong — parse
// each to a real instant with $dateFromString and take the $max. Returns null for an
// empty collection (nothing has been synced yet), in which case there is no floor to
// query updates against and the caller falls back to a full fetch.
async function greatest_last_modified(col: Collection<any>): Promise<Date | null> {
    const [res] = await col
        .aggregate<{ max: Date | null }>([
            { $group: { _id: null, max: { $max: { $dateFromString: { dateString: "$last_modified" } } } } },
        ])
        .toArray();
    return res?.max ?? null;
}

async function fetch_all<T>(
    label: string,
    fetch_page: (page: number) => Promise<{ items: T[]; more: boolean }>
): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    while (true) {
        const { items, more } = await fetch_page(page);
        all.push(...items);
        ilog(`[update:${label}] Page ${page}: fetched ${items.length} (total so far: ${all.length})`);
        if (!more) break;
        page++;
    }
    return all;
}

// Upsert mock docs by _id so an update run reflects both edits to existing rows and
// brand-new rows QBT returned. The _id moves to the filter (a replacement body can't
// carry it) and upsert inserts under that id when the row is absent.
async function upsert_by_id(col: Collection<any>, docs: Array<{ _id: number }>): Promise<void> {
    if (docs.length === 0) return;
    const ops: AnyBulkWriteOperation<any>[] = docs.map(({ _id, ...rest }) => ({
        replaceOne: { filter: { _id }, replacement: rest, upsert: true },
    }));
    await col.bulkWrite(ops);
}

function since_str(since: Date | null): string {
    return since ? since.toISOString() : "(none — full fetch)";
}

async function update_users(api: qbt_api_client) {
    const col = mongo.get_mock_users();
    const since = await greatest_last_modified(col);
    ilog(`[update:usi] Fetching users modified since ${since_str(since)}...`);
    const users = await fetch_all("usi", (p) =>
        api.fetch_users({ page: p, active: "both", modified_since: since ?? undefined })
    );
    ilog(`[update:usi] Upserting ${users.length} users...`);
    await upsert_by_id(col, users.map(to_mock_doc));
    ilog(`[update:usi] Done. ${users.length} document(s) upserted.`);
}

async function update_jobcodes(api: qbt_api_client) {
    const col = mongo.get_mock_jobcodes();
    const since = await greatest_last_modified(col);
    ilog(`[update:jc] Fetching jobcodes modified since ${since_str(since)}...`);
    const jobcodes = await fetch_all("jc", (p) =>
        api.fetch_jobcodes({ page: p, active: "both", modified_since: since ?? undefined })
    );
    ilog(`[update:jc] Upserting ${jobcodes.length} jobcodes...`);
    await upsert_by_id(col, jobcodes.map(to_mock_doc));
    ilog(`[update:jc] Done. ${jobcodes.length} document(s) upserted.`);
}

async function update_jobcode_assignments(api: qbt_api_client) {
    const col = mongo.get_mock_assignments();
    const since = await greatest_last_modified(col);
    ilog(`[update:jca] Fetching jobcode_assignments modified since ${since_str(since)}...`);
    const assignments = await fetch_all("jca", (p) =>
        api.fetch_jobcode_assignments({ page: p, modified_since: since ?? undefined })
    );
    ilog(`[update:jca] Upserting ${assignments.length} jobcode_assignments...`);
    await upsert_by_id(col, assignments.map(to_mock_doc));
    ilog(`[update:jca] Done. ${assignments.length} document(s) upserted.`);
}

async function update_timesheets(api: qbt_api_client) {
    const col = mongo.get_mock_timesheets();
    const since = await greatest_last_modified(col);

    ilog(`[update:ts] Fetching timesheets modified since ${since_str(since)}...`);
    const timesheets = await fetch_all("ts", (p) =>
        api.fetch_timesheets({ page: p, modified_since: since ?? undefined })
    );
    ilog(`[update:ts] Upserting ${timesheets.length} timesheets...`);
    await upsert_by_id(col, timesheets.map(to_mock_doc));
    ilog(`[update:ts] Done. ${timesheets.length} document(s) upserted.`);

    // QBT's timesheets_deleted feed requires a modified_since, and an empty collection
    // has nothing to remove anyway — so only reconcile deletions when we have a floor.
    if (!since) {
        ilog("[update:ts] No floor timestamp; skipping deleted-timesheet reconciliation.");
        return;
    }
    ilog(`[update:ts] Fetching deleted timesheets modified since ${since.toISOString()}...`);
    const deleted_ids = await fetch_all("ts-del", (p) =>
        api.fetch_deleted_timesheets({ page: p, modified_since: since }).then((r) => ({ items: r.ids, more: r.more }))
    );
    if (deleted_ids.length === 0) {
        ilog("[update:ts] No deleted timesheets to remove.");
        return;
    }
    const res = await col.deleteMany({ _id: { $in: deleted_ids } });
    ilog(`[update:ts] Removed ${res.deletedCount} deleted timesheet(s) (of ${deleted_ids.length} reported).`);
}

// Each updater, keyed by the CLI flag that selects it. Every entry computes the most
// recent last_modified already in its mock collection and pulls QBT updates since then,
// upserting the results. Invitations are intentionally absent — they're app-generated,
// not QBT data, so there's nothing to pull.
const UPDATERS: Record<string, { label: string; run: (api: qbt_api_client) => Promise<void> }> = {
    "--usi": { label: "users", run: update_users },
    "--jc": { label: "jobcodes", run: update_jobcodes },
    "--jca": { label: "jobcode assignments", run: update_jobcode_assignments },
    "--ts": { label: "timesheets (+ deletions)", run: update_timesheets },
};

function help_message(): string {
    const lines = [
        "Usage: npm run update_mock_db -- <types>",
        "",
        "Please specify which types to update:",
        ...Object.entries(UPDATERS).map(([flag, u]) => `  ${flag.padEnd(7)} update ${u.label}`),
        `  ${"--all".padEnd(7)} update all types`,
        `  ${"-h".padEnd(7)} show this help`,
    ];
    return lines.join("\n");
}

// Resolve CLI args into the list of updaters to run. Returns null when help should be
// shown (no args, or an explicit help flag).
function selected_updaters(argv: string[]): Array<(api: qbt_api_client) => Promise<void>> | null {
    if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) return null;
    if (argv.includes("--all")) return Object.values(UPDATERS).map((u) => u.run);

    const runs: Array<(api: qbt_api_client) => Promise<void>> = [];
    for (const arg of argv) {
        const updater = UPDATERS[arg];
        if (!updater) {
            elog(`[update] Unknown argument: ${arg}`);
            return null;
        }
        runs.push(updater.run);
    }
    return runs;
}

// Pulls incremental QBT updates into the selected mock collections, keyed off the most
// recent last_modified each collection already holds. Standalone operation — independent
// of the sync loops, and a complement to seed_mock_db (which wipes and full-copies).
export async function update_mock_db(runs: Array<(api: qbt_api_client) => Promise<void>>): Promise<void> {
    ilog("[update] Updating mock QBT from live API...");
    const api = new qbt_api_client();
    for (const run of runs) {
        await run(api);
    }
}

async function main(): Promise<void> {
    const runs = selected_updaters(process.argv.slice(2));
    if (!runs) {
        ilog(help_message());
        return;
    }

    await mongo.connect();
    try {
        await update_mock_db(runs);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[update] Fatal error:", err);
    process.exit(1);
});
