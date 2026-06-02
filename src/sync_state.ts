import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "fs";
import { resolve, dirname } from "path";
import { config } from "./config";

const STATE_FILE = config.sync_state_file;

export type timesheet_sync_state = {
    last_synced: Date | null; // inbound cursor: QBT modified_since
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
        last_synced: null,
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
            last_synced: state.timesheets?.last_synced ? new Date(state.timesheets.last_synced) : null,
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

// Single in-memory copy of the state, read from disk on first access and kept
// in sync with every save. Avoids re-reading the file on each load/save.
let cached_state: sync_state | null = null;

function read_from_disk(): sync_state {
    if (!existsSync(STATE_FILE)) {
        return structuredClone(default_state);
    }
    const raw = JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    return parse_dates(raw);
}

// Verify up front that the state file (and any parent dirs) can be created and
// written, so a misconfigured SYNC_STATE_FILE fails at startup rather than deep
// into a run on the first save. Seeds a fresh file with the default state when
// none exists; otherwise rewrites the current state to confirm writability now.
export function ensure_state_file_writable(): void {
    mkdirSync(dirname(resolve(STATE_FILE)), { recursive: true });
    if (!existsSync(STATE_FILE)) {
        write_state(default_state);
        ilog(`[sync_state] Created fresh state file at ${resolve(STATE_FILE)}.`);
    } else {
        write_state(get_sync_state());
    }
}

export function get_sync_state(): sync_state {
    if (!cached_state) cached_state = read_from_disk();
    return cached_state;
}

function write_state(state: sync_state): void {
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf-8");
}

export function save_timesheet_state(update: Partial<timesheet_sync_state>): void {
    const state = get_sync_state();
    state.timesheets = { ...state.timesheets, ...update };
    write_state(state);
}

export function save_user_state(update: Partial<user_sync_state>): void {
    const state = get_sync_state();
    state.users = { ...state.users, ...update };
    write_state(state);
}

export function save_jobcode_state(update: Partial<jobcode_sync_state>): void {
    const state = get_sync_state();
    state.jobcodes = { ...state.jobcodes, ...update };
    write_state(state);
}

// Tracks per-item sync progress so the cursor only advances past items that
// were actually resolved. `earliest_unresolved` floors the cursor at one ms
// before the earliest skipped/failed item, guaranteeing it gets re-fetched.
export const CURSOR_EPOCH = new Date(0); // default "sync from the beginning" cursor floor

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
    cached_state = null;
    if (existsSync(STATE_FILE)) {
        unlinkSync(STATE_FILE);
        ilog("[sync_state] Sync state reset.");
    } else {
        ilog("[sync_state] No sync state file found; nothing to reset.");
    }
}
