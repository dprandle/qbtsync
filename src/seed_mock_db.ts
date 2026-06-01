import "./global_setup"
import mongo from "./db";
import { qbt_api_client } from "./qbt_client";
import { to_mock_doc } from "./qbt_mock_client";

async function fetch_all<T>(
    label: string,
    fetch_page: (page: number) => Promise<{ items: T[]; more: boolean }>
): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    while (true) {
        const { items, more } = await fetch_page(page);
        all.push(...items);
        ilog(`[seed:${label}] Page ${page}: fetched ${items.length} (total so far: ${all.length})`);
        if (!more) break;
        page++;
    }
    return all;
}

async function clear_col(label: string, drop: () => Promise<boolean>): Promise<void> {
    ilog(`[seed:${label}] Dropping mock collection...`);
    try {
        await drop();
        ilog(`[seed:${label}] Dropped.`);
    } catch (err: any) {
        // NamespaceNotFound — collection didn't exist; nothing to do.
        if (err?.code !== 26) throw err;
        ilog(`[seed:${label}] Did not exist.`);
    }
}

async function seed_users(api: qbt_api_client) {
    ilog("[seed:usi] Seeding users...");
    await clear_col("usi", () => mongo.get_mock_users().drop());
    ilog("[seed:usi] Fetching users...");
    const users = await fetch_all("usi", (p) => api.fetch_users({ page: p, active: "both"}));
    ilog(`[seed:usi] Inserting ${users.length} users into mock collection...`);
    if (users.length > 0) await mongo.get_mock_users().insertMany(users.map(to_mock_doc));
    ilog(`[seed:usi] Done. ${users.length} document(s) inserted.`);
}

async function seed_jobcodes(api: qbt_api_client) {
    ilog("[seed:jc] Seeding jobcodes...");
    await clear_col("jc", () => mongo.get_mock_jobcodes().drop()),
    ilog("[seed:jc] Fetching jobcodes...");
    const jobcodes = await fetch_all("jc", (p) => api.fetch_jobcodes({ page: p, active: "both" }));
    ilog(`[seed:jc] Inserting ${jobcodes.length} jobcodes into mock collection...`);
    if (jobcodes.length > 0) await mongo.get_mock_jobcodes().insertMany(jobcodes.map(to_mock_doc));
    ilog(`[seed:jc] Done. ${jobcodes.length} document(s) inserted.`);
}

async function seed_jobcode_assignments(api: qbt_api_client) {
    ilog("[seed:jca] Seeding jobcode_assignments...");
    await clear_col("jca", () => mongo.get_mock_assignments().drop());
    ilog("[seed:jca] Fetching jobcode_assignments...");
    const jobcode_assignments = await fetch_all("jca", (p) => api.fetch_jobcode_assignments({ page: p }));
    ilog(`[seed:jca] Inserting ${jobcode_assignments.length} jobcode_assignments into mock collection...`);
    if (jobcode_assignments.length > 0) await mongo.get_mock_assignments().insertMany(jobcode_assignments.map(to_mock_doc));    
    ilog(`[seed:jca] Done. ${jobcode_assignments.length} document(s) inserted.`);
}

async function seed_timesheets(api: qbt_api_client) {
    ilog("[seed:ts] Seeding timesheets...");
    await clear_col("ts", () => mongo.get_mock_timesheets().drop());
    ilog("[seed:ts] Fetching timesheets...");
    const timesheets = await fetch_all("ts", (p) => api.fetch_timesheets({ page: p }));
    ilog(`[seed:ts] Inserting ${timesheets.length} timesheets into mock collection...`);
    if (timesheets.length > 0) await mongo.get_mock_timesheets().insertMany(timesheets.map(to_mock_doc));    
    ilog(`[seed:ts] Done. ${timesheets.length} document(s) inserted.`);
}


// Each seed type, keyed by the CLI flag that selects it. Every entry drops its
// own mock collection and repopulates it with a full copy of the live QBT data,
// independent of the others.
const SEEDERS: Record<string, { label: string; run: (api: qbt_api_client) => Promise<void> }> = {
    "--usi": { label: "users", run: seed_users },
    "--jc": { label: "jobcodes", run: seed_jobcodes },
    "--jca": { label: "jobcode assignments", run: seed_jobcode_assignments },
    "--ts": { label: "timesheets", run: seed_timesheets },
};

function help_message(): string {
    const lines = [
        "Usage: npm run seed_mock_db -- <types>",
        "",
        "Please specify which types to seed:",
        ...Object.entries(SEEDERS).map(([flag, s]) => `  ${flag.padEnd(7)} seed ${s.label}`),
        `  ${"--all".padEnd(7)} seed all types`,
        `  ${"-h".padEnd(7)} show this help`,
    ];
    return lines.join("\n");
}

// Resolve CLI args into the list of seeders to run. Returns null when help
// should be shown (no args, or an explicit help flag).
function selected_seeders(argv: string[]): Array<(api: qbt_api_client) => Promise<void>> | null {
    if (argv.length === 0 || argv.includes("-h") || argv.includes("--help")) return null;
    if (argv.includes("--all")) return Object.values(SEEDERS).map((s) => s.run);

    const runs: Array<(api: qbt_api_client) => Promise<void>> = [];
    for (const arg of argv) {
        const seeder = SEEDERS[arg];
        if (!seeder) {
            elog(`[seed] Unknown argument: ${arg}`);
            return null;
        }
        runs.push(seeder.run);
    }
    return runs;
}

// Clears the selected mock QBT collections and repopulates them with a full
// copy of the live QBT data. Standalone seed operation — independent of the
// sync loops.
export async function seed_mock_db(runs: Array<(api: qbt_api_client) => Promise<void>>): Promise<void> {
    ilog("[seed] Seeding mock QBT from live API...");
    const api = new qbt_api_client();
    for (const run of runs) {
        await run(api);
    }
}

async function main(): Promise<void> {
    const runs = selected_seeders(process.argv.slice(2));
    if (!runs) {
        ilog(help_message());
        return;
    }

    await mongo.connect();
    try {
        await seed_mock_db(runs);
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[seed] Fatal error:", err);
    process.exit(1);
});
