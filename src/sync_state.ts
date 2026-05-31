import { existsSync, readFileSync, writeFileSync, unlinkSync } from "fs";
import { resolve } from "path";
import { config } from "./config";

const STATE_FILE = config.sync_state_file;

// Guards the "starting fresh" log so it fires once per process rather than on
// every load (load_sync_state runs before each save, before the file exists).
let logged_fresh_state = false;

export type timesheet_sync_state = {
    full_import_complete: boolean;
    last_synced: Date | null; // inbound cursor: QBT modified_since
    full_import_page: number;
    outbound_last_synced: Date | null; // outbound cursor: time_records last_update.on
};

export type user_sync_state = {
    bootstrap_complete: boolean; // true once initial email-match bootstrap has run
    last_synced: Date | null; // hresource last_update.on cursor
};

export type jobcode_sync_state = {
    bootstrap_complete: boolean; // true once initial name-match bootstrap has run
    last_synced: Date | null; // contract_route last_update.on cursor
};

export type sync_state = {
    timesheets: timesheet_sync_state;
    users: user_sync_state;
    jobcodes: jobcode_sync_state;
};


const default_state: sync_state = {
    timesheets: {
        full_import_complete: false,
        last_synced: null,
        full_import_page: 1,
        outbound_last_synced: null,
    },
    users: {
        bootstrap_complete: false,
        last_synced: null,
    },
    jobcodes: {
        bootstrap_complete: false,
        last_synced: null,
    },
};

function parse_dates(state: any): sync_state {
    return {
        timesheets: {
            full_import_complete: state.timesheets?.full_import_complete ?? false,
            last_synced: state.timesheets?.last_synced ? new Date(state.timesheets.last_synced) : null,
            full_import_page: state.timesheets?.full_import_page ?? 1,
            outbound_last_synced: state.timesheets?.outbound_last_synced
                ? new Date(state.timesheets.outbound_last_synced)
                : null,
        },
        users: {
            bootstrap_complete: state.users?.bootstrap_complete ?? false,
            last_synced: state.users?.last_synced ? new Date(state.users.last_synced) : null,
        },
        jobcodes: {
            bootstrap_complete: state.jobcodes?.bootstrap_complete ?? false,
            last_synced: state.jobcodes?.last_synced ? new Date(state.jobcodes.last_synced) : null,
        },
    };
}

export function load_sync_state(): sync_state {
    if (!existsSync(STATE_FILE)) {
        if (!logged_fresh_state) {
            console.log(`[sync_state] No state file at ${resolve(STATE_FILE)} — starting from a fresh sync state.`);
            logged_fresh_state = true;
        }
        return { ...default_state };
    }
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return parse_dates(raw);
}

function write_state(state: sync_state): void {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function save_timesheet_state(update: Partial<timesheet_sync_state>): void {
    const state = load_sync_state();
    state.timesheets = { ...state.timesheets, ...update };
    write_state(state);
}

export function save_user_state(update: Partial<user_sync_state>): void {
    const state = load_sync_state();
    state.users = { ...state.users, ...update };
    write_state(state);
}

export function save_jobcode_state(update: Partial<jobcode_sync_state>): void {
    const state = load_sync_state();
    state.jobcodes = { ...state.jobcodes, ...update };
    write_state(state);
}

// Tracks per-item sync progress so the cursor only advances past items that
// were actually resolved. `earliest_unresolved` floors the cursor at one ms
// before the earliest skipped/failed item, guaranteeing it gets re-fetched.
export type cursor_progress = {
    latest_resolved: Date;
    earliest_unresolved: Date | null;
};

export function safe_cursor(progress: cursor_progress, since: Date): Date {
    let cursor = progress.latest_resolved;
    if (progress.earliest_unresolved) {
        const cap = new Date(progress.earliest_unresolved.getTime() - 1);
        if (cap < cursor) cursor = cap;
    }
    return cursor < since ? since : cursor;
}

export function reset_sync_state(): void {
    if (existsSync(STATE_FILE)) {
        unlinkSync(STATE_FILE);
        console.log("Sync state reset.");
    } else {
        console.log("No sync state file found; nothing to reset.");
    }
}
