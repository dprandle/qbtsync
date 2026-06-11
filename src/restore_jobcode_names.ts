import "./global_setup";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config";
import { qbt_api_client } from "./qbt_client";
import { qbt_client, qbt_jobcode, fetch_all_by_ids } from "./qbt_client_interface";

// One-off recovery: restore live QBT jobcode names from a snapshot taken before a
// botched rename. We restore every jobcode that was *active in the snapshot*. For
// those archived in live now, the rename also reactivates them (active: true in the
// same call) — QBT only allows updating an archived jobcode when that update sets it
// active. Jobcodes archived in the snapshot are not restorable and are skipped.
//
// Dry-run by default: it prints every change it *would* make (renames and
// reactivations tagged distinctly). Pass --apply to actually write. The snapshot is
// the raw QBT jobcodes API response (the object with a top-level "data" map); path
// defaults to ./jobcode_name_snapshot.json or the first non-flag argument.

type snapshot_entry = { id: number; name: string; active: number };

function load_snapshot(file: string): Map<number, string> {
    const raw = fs.readFileSync(file, "utf8");
    const parsed = JSON.parse(raw) as { data: Record<string, snapshot_entry> };
    if (!parsed.data) throw new Error(`Snapshot ${file} has no top-level "data" map`);
    // Only active entries are restorable; key by numeric id -> desired name.
    const desired = new Map<number, string>();
    let archived = 0;
    for (const entry of Object.values(parsed.data)) {
        if (entry.active === 1) desired.set(entry.id, entry.name);
        else archived++;
    }
    ilog(`[restore] Snapshot: ${Object.keys(parsed.data).length} jobcodes (${desired.size} active, ${archived} archived/skipped)`);
    return desired;
}

async function main(): Promise<void> {
    const args = process.argv.slice(2);
    const apply = args.includes("--apply");
    const file_arg = args.find((a) => !a.startsWith("--"));
    const file = path.resolve(file_arg ?? "jobcode_name_snapshot.json");

    const desired = load_snapshot(file);

    // This reads/writes LIVE QuickBooks Time and keys off live jobcode ids from the
    // snapshot, so it only runs against prod — never the dev mock (whose ids and DB
    // wouldn't match, and which needs a Mongo connection this tool doesn't open).
    if (config.qbt_env !== "prod") {
        elog(`[restore] Refusing to run with QBT_ENV=${config.qbt_env}. Re-run with QBT_ENV=prod (this hits LIVE QBT).`);
        process.exit(1);
    }
    const qbt: qbt_client = new qbt_api_client();
    ilog(`[restore] QBT_ENV=prod — LIVE QBT client`);

    // Fetch the current live state (name + active) for exactly the snapshot's active
    // ids — active: "both" so we also see ones archived in live, which we reactivate.
    const live_list = await fetch_all_by_ids([...desired.keys()], (ids) => qbt.fetch_jobcodes({ ids, active: "both" }));
    const live = new Map(live_list.map((jc) => [jc.id, jc]));
    ilog(`[restore] Live: matched ${live.size} of ${desired.size} snapshot-active jobcodes`);

    const changes: { id: number; from: string; to: string; reactivate: boolean }[] = [];
    const missing: number[] = []; // in snapshot but not found in live at all (deleted?)
    let already_ok = 0;

    for (const [id, name] of desired) {
        const jc = live.get(id);
        if (!jc) {
            missing.push(id);
            continue;
        }
        const rename = jc.name !== name;
        const reactivate = !jc.active;
        if (!rename && !reactivate) {
            already_ok++;
            continue;
        }
        changes.push({ id, from: jc.name, to: name, reactivate });
    }

    const reactivations = changes.filter((c) => c.reactivate).length;
    ilog(
        `[restore] ${already_ok} already correct, ${changes.length} to restore (${reactivations} also reactivated), ${missing.length} not found in live`
    );
    for (const id of missing) {
        wlog(`[restore] SKIP ${id}: not found in live QBT (deleted?) — desired "${desired.get(id)}"`);
    }
    for (const c of changes) {
        const tag = c.reactivate ? " [REACTIVATE]" : "";
        ilog(`[restore] ${apply ? "UPDATE" : "WOULD UPDATE"} ${c.id}${tag}: "${c.from}" -> "${c.to}"`);
    }

    if (!apply) {
        ilog(
            `[restore] DRY RUN — ${changes.length} jobcode(s) would change (${reactivations} reactivated). Re-run with --apply to write.`
        );
        return;
    }

    let ok = 0;
    let failed = 0;
    for (const c of changes) {
        const updates: Partial<qbt_jobcode> = {};
        if (c.from !== c.to) updates.name = c.to;
        // QBT only permits updating an archived jobcode if the call also reactivates it.
        if (c.reactivate) updates.active = true;
        try {
            const result = await qbt.update_jobcode(c.id, updates);
            ilog(`[restore] Updated ${c.id} -> "${result.name}" (active=${result.active})`);
            ok++;
        } catch (err) {
            elog(`[restore] FAILED ${c.id} -> "${c.to}":`, err);
            failed++;
        }
    }
    ilog(`[restore] Done. Updated ${ok}, failed ${failed}, not-found ${missing.length}, already-correct ${already_ok}.`);
}

main().catch((err) => {
    elog("[restore] Fatal error:", err);
    process.exit(1);
});
