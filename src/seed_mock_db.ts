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
        console.log(`[seed:${label}] Page ${page}: fetched ${items.length} (total so far: ${all.length})`);
        if (!more) break;
        page++;
    }
    return all;
}

async function clear_col(label: string, drop: () => Promise<boolean>): Promise<void> {
    console.log(`[seed:${label}] Dropping mock collection...`);
    try {
        await drop();
        console.log(`[seed:${label}] Dropped.`);
    } catch (err: any) {
        // NamespaceNotFound — collection didn't exist; nothing to do.
        if (err?.code !== 26) throw err;
        console.log(`[seed:${label}] Did not exist.`);
    }
}

// Clears the mock QBT collections and repopulates them with a full copy of the
// live QBT data. Standalone seed operation — independent of the sync loops.
export async function seed_mock_db(): Promise<void> {
    console.log("[seed] Seeding mock QBT from live API...");
    const api = new qbt_api_client();

    // Clear all mock collections
    await Promise.all([
        clear_col("users", () => mongo.get_mock_users().drop()),
        clear_col("jobcodes", () => mongo.get_mock_jobcodes().drop()),
        clear_col("assignments", () => mongo.get_mock_assignments().drop()),
        clear_col("timesheets", () => mongo.get_mock_timesheets().drop()),
    ]);

    // Fetch all data from live QBT (in parallel; page logs will interleave by label)
    const [users, jobcodes, assignments, timesheets] = await Promise.all([
        fetch_all("users", (p) => api.fetch_users({ page: p })),
        fetch_all("jobcodes", (p) => api.fetch_jobcodes({ page: p })),
        fetch_all("assignments", (p) => api.fetch_jobcode_assignments({ page: p })),
        fetch_all("timesheets", (p) => api.fetch_timesheets({ page: p })),
    ]);

    // Insert into mock collections
    console.log("[seed:users] Inserting into mock collection...");
    if (users.length > 0) await mongo.get_mock_users().insertMany(users.map(to_mock_doc) as any[]);
    console.log(`[seed:users] Done. ${users.length} document(s) inserted.`);

    console.log("[seed:jobcodes] Inserting into mock collection...");
    if (jobcodes.length > 0) await mongo.get_mock_jobcodes().insertMany(jobcodes.map(to_mock_doc) as any[]);
    console.log(`[seed:jobcodes] Done. ${jobcodes.length} document(s) inserted.`);

    console.log("[seed:assignments] Inserting into mock collection...");
    if (assignments.length > 0) await mongo.get_mock_assignments().insertMany(assignments.map(to_mock_doc) as any[]);
    console.log(`[seed:assignments] Done. ${assignments.length} document(s) inserted.`);

    console.log("[seed:timesheets] Inserting into mock collection...");
    if (timesheets.length > 0) await mongo.get_mock_timesheets().insertMany(timesheets.map(to_mock_doc) as any[]);
    console.log(`[seed:timesheets] Done. ${timesheets.length} document(s) inserted.`);

    console.log("[seed] Mock QBT seed complete.");
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
    console.error("[seed] Fatal error:", err);
    process.exit(1);
});
