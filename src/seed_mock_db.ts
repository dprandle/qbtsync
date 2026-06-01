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

// Clears the mock QBT collections and repopulates them with a full copy of the
// live QBT data. Standalone seed operation — independent of the sync loops.
export async function seed_mock_db(): Promise<void> {
    ilog("[seed] Seeding mock QBT from live API...");
    const api = new qbt_api_client();

    // Clear all mock collections
    await Promise.all([
        clear_col("usi", () => mongo.get_mock_users().drop()),
        clear_col("jc", () => mongo.get_mock_jobcodes().drop()),
        clear_col("jca", () => mongo.get_mock_assignments().drop()),
        clear_col("ts", () => mongo.get_mock_timesheets().drop()),
    ]);

    // Fetch all data from live QBT (in parallel; page logs will interleave by label)
    const [users, jobcodes, assignments, timesheets] = await Promise.all([
        fetch_all("usi", (p) => api.fetch_users({ page: p, active: "both"})),
        fetch_all("jc", (p) => api.fetch_jobcodes({ page: p, active: "both" })),
        fetch_all("jca", (p) => api.fetch_jobcode_assignments({ page: p })),
        fetch_all("ts", (p) => api.fetch_timesheets({ page: p })),
    ]);

    // Insert into mock collections
    ilog("[seed:usi] Inserting into mock collection...");
    if (users.length > 0) await mongo.get_mock_users().insertMany(users.map(to_mock_doc));
    ilog(`[seed:usi] Done. ${users.length} document(s) inserted.`);

    ilog("[seed:jc] Inserting into mock collection...");
    if (jobcodes.length > 0) await mongo.get_mock_jobcodes().insertMany(jobcodes.map(to_mock_doc));
    ilog(`[seed:jc] Done. ${jobcodes.length} document(s) inserted.`);

    ilog("[seed:jca] Inserting into mock collection...");
    if (assignments.length > 0) await mongo.get_mock_assignments().insertMany(assignments.map(to_mock_doc));
    ilog(`[seed:jca] Done. ${assignments.length} document(s) inserted.`);

    ilog("[seed:ts] Inserting into mock collection...");
    if (timesheets.length > 0) await mongo.get_mock_timesheets().insertMany(timesheets.map(to_mock_doc));
    ilog(`[seed:ts] Done. ${timesheets.length} document(s) inserted.`);

    ilog("[seed] Mock QBT seed complete.");
}

async function main(): Promise<void> {
    await mongo.connect();
    try {
        await seed_mock_db();
    } finally {
        await mongo.disconnect();
    }
}

main().catch((err) => {
    elog("[seed] Fatal error:", err);
    process.exit(1);
});
