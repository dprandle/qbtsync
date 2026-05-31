import mongo from "./db";
import { qbt_api_client } from "./qbt_client";

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

async function clear_col(label: string, del: () => Promise<{ deletedCount?: number }>): Promise<void> {
    console.log(`[seed:${label}] Clearing mock collection...`);
    const result = await del();
    console.log(`[seed:${label}] Cleared ${result.deletedCount ?? 0} existing document(s).`);
}

// Clears the mock QBT collections and repopulates them with a full copy of the
// live QBT data. Standalone seed operation — independent of the sync loops.
export async function seed_mock_db(): Promise<void> {
    console.log("[seed] Seeding mock QBT from live API...");
    const api = new qbt_api_client();

    // Clear all mock collections
    await Promise.all([
        clear_col("users", () => mongo.get_mock_users().deleteMany({})),
        clear_col("jobcodes", () => mongo.get_mock_jobcodes().deleteMany({})),
        clear_col("assignments", () => mongo.get_mock_assignments().deleteMany({})),
        clear_col("timesheets", () => mongo.get_mock_timesheets().deleteMany({})),
    ]);

    // Fetch all data from live QBT (in parallel; page logs will interleave by label)
    const [users, jobcodes, assignments, timesheets] = await Promise.all([
        fetch_all("users", (p) => api.fetch_users({ page: p }).then((r) => ({ items: r.users, more: r.more }))),
        fetch_all("jobcodes", (p) =>
            api.fetch_jobcodes({ page: p }).then((r) => ({ items: r.jobcodes, more: r.more }))
        ),
        fetch_all("assignments", (p) =>
            api.fetch_jobcode_assignments({ page: p }).then((r) => ({ items: r.assignments, more: r.more }))
        ),
        fetch_all("timesheets", (p) =>
            api.fetch_timesheets({ page: p }).then((r) => ({ items: r.timesheets, more: r.more }))
        ),
    ]);

    // Insert into mock collections
    console.log("[seed:users] Inserting into mock collection...");
    if (users.length > 0) await mongo.get_mock_users().insertMany(users as any[]);
    console.log(`[seed:users] Done. ${users.length} document(s) inserted.`);

    console.log("[seed:jobcodes] Inserting into mock collection...");
    if (jobcodes.length > 0) await mongo.get_mock_jobcodes().insertMany(jobcodes as any[]);
    console.log(`[seed:jobcodes] Done. ${jobcodes.length} document(s) inserted.`);

    console.log("[seed:assignments] Inserting into mock collection...");
    if (assignments.length > 0) await mongo.get_mock_assignments().insertMany(assignments as any[]);
    console.log(`[seed:assignments] Done. ${assignments.length} document(s) inserted.`);

    console.log("[seed:timesheets] Inserting into mock collection...");
    if (timesheets.length > 0) await mongo.get_mock_timesheets().insertMany(timesheets as any[]);
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
