import mongo from "./db";
import { save_user_state, get_sync_state, cursor_progress, safe_cursor, CURSOR_EPOCH } from "./sync_state";
import { create_qbt_object_map_item, primary_by_our_id } from "./qbt_object_map";
import { change_info, is_active, make_ci_now, uid } from "./uobj_common";
import { qbt_client, qbt_user, fetch_all_by_ids } from "./qbt_client_interface";
import {
    EMP_ACTIVE_ROLE_KEYS,
    is_awarded,
    reconcile_jc_assignments_by_user,
    prefetch_active_assignments_by_user,
} from "./assignments";

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

// `actual_by_user` is the loop-level prefetch of current assignments keyed by QBT
// user_id (see update_users_from_hres). We index it by the resolved user's id to
// reconcile without a per-user assignments GET; a newly created user isn't in it,
// so it falls back to an empty map (a brand-new user has no assignments).
async function process_hres_update(
    hres: hresource_doc,
    qbt: qbt_client,
    actual_by_user: Map<number, Map<number, number>>
): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_qbt_user(hres.tt_flags, hres.archived_info.on);
    // An hres may have several linked QBT users (historical duplicates); reconcile
    // the primary (lowest link_id) — the canonical live user. Duplicates are
    // archived and only kept so their old timesheets resolve inbound.
    const mapping = await map_col.findOne({ type: "user", our_id: hres._id }, { sort: { link_id: 1 } });

    let usi: qbt_user | null = null;
    if (mapping) {
        usi = await qbt.fetch_user(mapping.qbt_id);
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
    const actual = actual_by_user.get(usi.id) ?? new Map<number, number>();
    if (!usi.active) {
        ilog(
            `[jca] Starting sync - archiving any assignments for ${get_hres_log_str(hres)} (${get_user_log_str(usi)})`
        );
        await reconcile_jc_assignments_by_user(qbt, usi.id, new Set(), actual);
        return;
    }

    // Find awarded+active contracts where this hres is linked under an employee role.
    const role_filters = [...EMP_ACTIVE_ROLE_KEYS].map((role) => ({
        [`assignments.${role}.emp_id`]: hres._id,
    }));
    const contracts = await mongo.get_conts().find({ $or: role_filters }).toArray();
    const cont_ids = contracts.filter((c) => is_active(c.archived_info.on) && is_awarded(c)).map((c) => c._id);

    const desired = new Set<number>();
    if (cont_ids.length > 0) {
        const cont_maps = await map_col.find({ type: "jobcode", our_id: { $in: cont_ids } }).toArray();
        // Assign against the primary jobcode per contract; duplicate-link jobcodes
        // are archived leftovers we don't push new assignments onto.
        const qbt_jc_ids = [...primary_by_our_id(cont_maps).values()].map((r) => r.qbt_id);
        const jcs = await fetch_all_by_ids(qbt_jc_ids, (ids) => qbt.fetch_jobcodes({ ids, active: "yes" }));
        jcs.forEach((jc) => desired.add(jc.id));
    }
    ilog(
        `[jca] Starting sync - ${desired.size} desired assignments for ${get_hres_log_str(hres)} (usi: ${get_user_log_str(usi)})`
    );
    await reconcile_jc_assignments_by_user(qbt, usi.id, desired, actual);
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

    // Prefetch every changed hres's current QBT assignments up front. The endpoint
    // takes user_ids in bulk, so this is a few paginated reads instead of one GET
    // per hres inside the loop. Keyed by primary (lowest link_id) user qbt_id — the
    // same id process_hres_update resolves for an existing mapping; new hres aren't
    // here yet and reconcile against an empty map.
    const map_col = mongo.get_qbt_map_objects();
    const user_maps = await map_col.find({ type: "user", our_id: { $in: changed.map((h) => h._id) } }).toArray();
    const primary_user_ids = [...primary_by_our_id(user_maps).values()].map((m) => m.qbt_id);
    const actual_by_user = await prefetch_active_assignments_by_user(qbt, primary_user_ids);

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    for (let i = 0; i < changed.length; ++i) {
        const hres = changed[i];
        const at = hres.last_update.on;
        ilog(`[usi] Processing update for ${get_hres_log_str(hres)} (${i + 1} of ${changed.length})`);
        try {
            await process_hres_update(hres, qbt, actual_by_user);
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
