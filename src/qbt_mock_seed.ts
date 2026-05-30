import { QbtApiClient } from "./qbt_client";
import { qbt_mock_client } from "./qbt_mock_client";
import {
    get_mock_users_collection,
    get_mock_jobcodes_collection,
    get_mock_assignments_collection,
    get_mock_timesheets_collection,
} from "./db";

async function fetch_all<T>(
    label: string,
    fetch_page: (page: number) => Promise<{ items: T[]; more: boolean }>
): Promise<T[]> {
    const all: T[] = [];
    let page = 1;
    while (true) {
        const { items, more } = await fetch_page(page);
        all.push(...items);
        console.log(`[dev:${label}] Page ${page}: fetched ${items.length} (total so far: ${all.length})`);
        if (!more) break;
        page++;
    }
    return all;
}

async function clear_col(label: string, del: () => Promise<{ deletedCount?: number }>): Promise<void> {
    console.log(`[dev:${label}] Clearing mock collection...`);
    const result = await del();
    console.log(`[dev:${label}] Cleared ${result.deletedCount ?? 0} existing document(s).`);
}

export async function seed_mock_qbt(): Promise<qbt_mock_client> {
    console.log("[dev] Seeding mock QBT from live API...");
    const api = new QbtApiClient();

    // Clear all mock collections
    await Promise.all([
        clear_col("users", () => get_mock_users_collection().deleteMany({})),
        clear_col("jobcodes", () => get_mock_jobcodes_collection().deleteMany({})),
        clear_col("assignments", () => get_mock_assignments_collection().deleteMany({})),
        clear_col("timesheets", () => get_mock_timesheets_collection().deleteMany({})),
    ]);

    // Fetch all data from live QBT (in parallel; page logs will interleave by label)
    const [users, jobcodes, assignments, timesheets] = await Promise.all([
        fetch_all("users", (p) => api.fetch_users({ page: p }).then((r) => ({ items: r.users, more: r.more }))),
        fetch_all("jobcodes", (p) => api.fetch_jobcodes({ page: p }).then((r) => ({ items: r.jobcodes, more: r.more }))),
        fetch_all("assignments", (p) => api.fetch_jobcode_assignments({ page: p }).then((r) => ({ items: r.assignments, more: r.more }))),
        fetch_all("timesheets", (p) => api.fetch_timesheets({ page: p }).then((r) => ({ items: r.timesheets, more: r.more }))),
    ]);

    // Insert into mock collections
    console.log("[dev:users] Inserting into mock collection...");
    if (users.length > 0) await get_mock_users_collection().insertMany(users as any[]);
    console.log(`[dev:users] Done. ${users.length} document(s) inserted.`);

    console.log("[dev:jobcodes] Inserting into mock collection...");
    if (jobcodes.length > 0) await get_mock_jobcodes_collection().insertMany(jobcodes as any[]);
    console.log(`[dev:jobcodes] Done. ${jobcodes.length} document(s) inserted.`);

    console.log("[dev:assignments] Inserting into mock collection...");
    if (assignments.length > 0) await get_mock_assignments_collection().insertMany(assignments as any[]);
    console.log(`[dev:assignments] Done. ${assignments.length} document(s) inserted.`);

    console.log("[dev:timesheets] Inserting into mock collection...");
    if (timesheets.length > 0) await get_mock_timesheets_collection().insertMany(timesheets as any[]);
    console.log(`[dev:timesheets] Done. ${timesheets.length} document(s) inserted.`);

    console.log("[dev] Mock QBT seed complete.");
    return new qbt_mock_client();
}
