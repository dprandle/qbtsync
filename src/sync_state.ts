import { existsSync, readFileSync, writeFileSync } from "fs";
import { sync_state } from "./types";

const STATE_FILE = "./sync_state.json";

const default_state: sync_state = {
    full_import_complete: false,
    last_synced: null,
    full_import_page: 1,
};

export function load_sync_state(): sync_state {
    if (!existsSync(STATE_FILE)) return { ...default_state };

    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return {
        ...raw,
        last_synced: raw.last_synced ? new Date(raw.last_synced) : null,
    };
}

export function save_sync_state(update: Partial<sync_state>): void {
    const current = load_sync_state();
    writeFileSync(STATE_FILE, JSON.stringify({ ...current, ...update }, null, 2), "utf-8");
}
