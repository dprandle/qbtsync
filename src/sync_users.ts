import mongo from "./db";
import { save_user_state, get_sync_state, cursor_progress, safe_cursor, CURSOR_EPOCH } from "./sync_state";
import { create_qbt_object_map_item, primary_by_our_id } from "./qbt_object_map";
import { change_info, is_active, make_ci_now, uid } from "./uobj_common";
import { qbt_client, qbt_user, fetch_all_by_ids } from "./qbt_client_interface";
import {
    EMP_ACTIVE_ROLE_KEYS,
    reconcile_jc_assignments_by_user,
    prefetch_active_assignments_by_user,
} from "./assignments";
import { emp_hres_ids, should_have_active_qbt_jobcode } from "./sync_jobcodes";

// Bit 0 of tt_flags — mirrors TIME_TRACKING_APP in hres.h
const TIME_TRACKING_APP = 1;

export type hresource_doc = {
    _id: string;
    first_name: string;
    last_name: string;
    email: string;
    phone_number: string;
    tt_flags: number;
    archived_info: change_info;
    last_update: change_info;
    allowed_roles: uid[];
};

export function should_have_qbt_user(tt_flags: number, archived_on: Date): boolean {
    const tracking_enabled = (tt_flags & TIME_TRACKING_APP) !== 0;
    return is_active(archived_on) && tracking_enabled;
}

export function get_hres_log_str(hr: hresource_doc): string {
    return `${hr.last_name}, ${hr.first_name} (${hr.email}:${hr._id})`;
}

export function get_user_log_str(usr: qbt_user): string {
    return `${usr.last_name}, ${usr.first_name} (${usr.email}:${usr.id})`;
}

export function normalize_email(s: string): string {
    return s.trim().toLowerCase();
}

export function normalize_phone_number(phone_str: string): string {
    let num = phone_str.replace(/\D/g, "");
    if (num.length === 11 && num.startsWith("1")) {
        num = num.slice(1);
    }
    return num.slice(0, 10);
}

// Loop-level prefetches that let process_hres_update run without per-hres QBT
// GETs (see update_users_from_hres). All keyed by the primary (lowest link_id)
// user/jobcode — the same objects process_hres_update resolves for an existing
// mapping.
type usi_loop_cache = {
    users_by_id: Map<number, qbt_user>; // primary user qbt_id -> current QBT user
    actual_by_user: Map<number, Map<number, number>>; // user qbt_id -> current assignments (jobcode_id -> asgn id)
    desired_by_hres: Map<string, Set<number>>; // hres _id -> desired active jobcode qbt_ids
};

async function process_hres_update(hres: hresource_doc, qbt: qbt_client, cache: usi_loop_cache): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_qbt_user(hres.tt_flags, hres.archived_info.on);
    // An hres may have several linked QBT users (historical duplicates); reconcile
    // the primary (lowest link_id) — the canonical live user. Duplicates are
    // archived and only kept so their old timesheets resolve inbound.
    const mapping = await map_col.findOne({ type: "user", our_id: hres._id }, { sort: { link_id: 1 } });

    let usi: qbt_user | null = null;
    if (mapping) {
        // From the loop prefetch; fall back to a direct fetch if absent (the user
        // was created since the prefetch, or is missing in QBT — fetch_user then
        // throws, preserving the original behavior).
        usi = cache.users_by_id.get(mapping.qbt_id) ?? (await qbt.fetch_user(mapping.qbt_id));
        const updates: Partial<qbt_user> = {};
        const norm_hr_email = normalize_email(hres.email);
        const norm_hr_phone = normalize_phone_number(hres.phone_number);

        // We can only update a user if they are active (besides setting active to true). QBT also allows
        // other updates on archived users as long as one of updates is setting the user to active
        if (want) {
            if (!usi.active) updates.active = true;
            if (usi.email !== norm_hr_email) updates.email = norm_hr_email;
            if (usi.username !== norm_hr_email) updates.username = norm_hr_email;
            if (usi.mobile_number !== norm_hr_phone) updates.mobile_number = norm_hr_phone;
            if (usi.first_name !== hres.first_name) updates.first_name = hres.first_name;
            if (usi.last_name !== hres.last_name) updates.last_name = hres.last_name;
        } else if (usi.active) {
            updates.active = false;
        }
        if (Object.keys(updates).length > 0) {
            usi = await qbt.update_user(usi.id, updates);
            ilog(`[usi] Updated ${get_user_log_str(usi)} with:`, updates);

            // We don't really HAVE to update the mapping, but it could help with debugging to see that our mod dates match
            const qbt_update = {
                $set: {
                    qbt_modified: new Date(usi.last_modified),
                    last_update: make_ci_now(),
                },
            };
            await map_col.updateOne({ _id: mapping._id }, qbt_update);
            ilog(`[usi] Updated mapping ${mapping._id} with updated usi last mod ${usi.last_modified}`);
        } else {
            ilog(`[usi] No changes`);
        }
    } else if (want) {
        // Create a new user for this hresource
        const norm_hr_email = normalize_email(hres.email);
        usi = await qbt.create_user({
            username: norm_hr_email,
            email: norm_hr_email,
            first_name: hres.first_name,
            last_name: hres.last_name,
            mobile_number: normalize_phone_number(hres.phone_number),
        });
        const map_obj = create_qbt_object_map_item(usi.id, hres._id, "user", new Date(usi.last_modified));
        await map_col.insertOne(map_obj);
        ilog(`[usi] Created:`, usi, `and associated mapping ${map_obj._id}`);
    } else {
        ilog(`[usi] No changes`);
    }

    // Reconcile this user's assignments now that its active state is settled.
    if (!usi) return;
    const actual = cache.actual_by_user.get(usi.id) ?? new Map<number, number>();
    if (!usi.active) {
        ilog(
            `[jca] Starting sync - archiving any assignments for ${get_hres_log_str(hres)} (${get_user_log_str(usi)})`
        );
        await reconcile_jc_assignments_by_user(qbt, usi.id, new Set(), actual);
        return;
    }

    // Desired jobcode assignments were resolved in bulk up front (awarded+active
    // contracts employing this hres → their primary, active jobcodes).
    const desired = cache.desired_by_hres.get(hres._id) ?? new Set<number>();
    ilog(
        `[jca] Starting sync - ${desired.size} desired assignments for ${get_hres_log_str(hres)} (usi: ${get_user_log_str(usi)})`
    );
    await reconcile_jc_assignments_by_user(qbt, usi.id, desired, actual);
}

// Precompute desired QBT jobcode assignments for every changed hres in one batched
// pass, so the per-hres loop issues no QBT reads for them. Mirrors the original
// per-hres rule: awarded+active contracts that employ the hres under an active
// role, each such contract's primary (lowest link_id) jobcode, kept only if that
// jobcode is currently active in QBT. Returns hres _id -> active jobcode qbt_ids.
async function prefetch_desired_jc_by_hres(qbt: qbt_client, hres_ids: string[]): Promise<Map<string, Set<number>>> {
    const out = new Map<string, Set<number>>();
    if (hres_ids.length === 0) return out;
    const map_col = mongo.get_qbt_map_objects();
    const hres_set = new Set(hres_ids);

    // One query for every contract employing any changed hres under an active role.
    const role_or = [...EMP_ACTIVE_ROLE_KEYS].map((role) => ({
        [`assignments.${role}.emp_id`]: { $in: hres_ids },
    }));
    const contracts = (await mongo.get_conts().find({ $or: role_or }).toArray()).filter(should_have_active_qbt_jobcode);
    if (contracts.length === 0) return out;

    // Primary jobcode per contract, then resolve which of those are active in QBT
    // in a single batched fetch over the unique candidate ids.
    const cont_maps = await map_col.find({ type: "jobcode", our_id: { $in: contracts.map((c) => c._id) } }).toArray();
    const primary_jc = primary_by_our_id(cont_maps); // cont_id -> jobcode map
    const candidate_ids = [...new Set([...primary_jc.values()].map((m) => m.qbt_id))];
    const active_jcs = await fetch_all_by_ids(candidate_ids, (ids) => qbt.fetch_jobcodes({ ids, active: "yes" }));
    const active_ids = new Set(active_jcs.map((jc) => jc.id));

    // Attribute each active primary jobcode to the changed hres its contract employs.
    for (const c of contracts) {
        const jc = primary_jc.get(c._id);
        if (!jc || !active_ids.has(jc.qbt_id)) continue;
        for (const hid of emp_hres_ids(c)) {
            if (!hres_set.has(hid)) continue;
            let set = out.get(hid);
            if (!set) {
                set = new Set<number>();
                out.set(hid, set);
            }
            set.add(jc.qbt_id);
        }
    }
    return out;
}

export async function update_users_from_hres(qbt: qbt_client): Promise<void> {
    const state = get_sync_state();
    const since = state.users.last_synced ?? CURSOR_EPOCH;
    ilog(`[usi] Delta sync since ${since.toISOString()}`);

    // Query hresources modified since the cursor
    const changed = await mongo
        .get_hresources()
        .find({ "last_update.on": { $gt: since } })
        .toArray();

    // Prefetch in bulk everything the per-hres loop reads from QBT — the current
    // user objects, their current assignments, and their desired assignments — so
    // the loop issues only the writes an actual change requires, no per-hres GETs.
    // All key off the primary (lowest link_id) user/jobcode, matching what
    // process_hres_update resolves for an existing mapping; new hres aren't mapped
    // yet, so they fall through to a create and an empty assignment reconcile.
    const map_col = mongo.get_qbt_map_objects();
    const hres_ids = changed.map((h) => h._id);
    const user_maps = await map_col.find({ type: "user", our_id: { $in: hres_ids } }).toArray();
    const primary_user_ids = [...primary_by_our_id(user_maps).values()].map((m) => m.qbt_id);

    const [user_list, actual_by_user, desired_by_hres] = await Promise.all([
        fetch_all_by_ids(primary_user_ids, (ids) => qbt.fetch_users({ ids, active: "both" })),
        prefetch_active_assignments_by_user(qbt, primary_user_ids),
        prefetch_desired_jc_by_hres(qbt, hres_ids),
    ]);
    const cache: usi_loop_cache = {
        users_by_id: new Map(user_list.map((u) => [u.id, u])),
        actual_by_user,
        desired_by_hres,
    };

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    for (let i = 0; i < changed.length; ++i) {
        const hres = changed[i];
        const at = hres.last_update.on;
        ilog(`[usi] Processing update for ${get_hres_log_str(hres)} (${i + 1} of ${changed.length})`);
        try {
            await process_hres_update(hres, qbt, cache);
            if (at > progress.latest_resolved) progress.latest_resolved = at;
        } catch (err) {
            elog(`[usi] Error syncing hres ${get_hres_log_str(hres)}:`, err);
            if (!progress.earliest_unresolved || at < progress.earliest_unresolved) {
                progress.earliest_unresolved = at;
            }
        }
    }

    const latest = safe_cursor(progress, since);
    if (latest > since) {
        save_user_state({ last_synced: latest });
        ilog(`[usi] Cursor advanced to ${latest.toISOString()}`);
    } else {
        ilog("[usi] No hresource changes.");
    }
}
