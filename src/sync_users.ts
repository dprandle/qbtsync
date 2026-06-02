import mongo from "./db";
import type { AnyBulkWriteOperation } from "mongodb";
import { save_user_state, get_sync_state, cursor_progress, safe_cursor, CURSOR_EPOCH } from "./sync_state";
import { create_qbt_object_map_item, type qbt_object_map } from "./qbt_object_map";
import { change_info, is_active, make_ci_now } from "./uobj_common";
import { qbt_client, qbt_user, fetch_all_by_ids, active_param } from "./qbt_client_interface";
import { EMP_ROLE_KEYS, is_awarded, reconcile_jc_assignments_by_user } from "./assignments";
import { ask_yes_no } from "./util";

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
};

function should_have_qbt_user(tt_flags: number, archived_on: Date): boolean {
    const tracking_enabled = (tt_flags & TIME_TRACKING_APP) !== 0;
    return is_active(archived_on) && tracking_enabled;
}

function get_hres_log_str(hr: hresource_doc): string {
    return `${hr.last_name}, ${hr.first_name} (${hr.email}:${hr._id})`;
}

function get_user_log_str(usr: qbt_user): string {
    return `${usr.last_name}, ${usr.first_name} (${usr.email}:${usr.id})`;
}

function normalize_email(s: string): string {
    return s.trim().toLowerCase();
}

function normalize_phone_number(phone_str: string): string {
    let num = phone_str.replace(/\D/g, "");
    if (num.length === 11 && num.startsWith("1")) {
        num = num.slice(1);
    }
    return num.slice(0, 10);
}

async function bootstrap_users_loop(
    qbt: qbt_client,
    hres_by_email: Map<string, hresource_doc>,
    active: active_param
): Promise<qbt_user[]> {
    const map_col = mongo.get_qbt_map_objects();
    let page = 1;
    let nomatches: qbt_user[] = [];
    while (true) {
        const { items: users, more } = await qbt.fetch_users({ page, active });
        ilog(`[usi] Trying to match ${users.length} ${active === "yes" ? "active" : "archived"} users to hres`);

        // Match emails up front (cheap, in-memory) so we know which hres ids to prefetch.
        const matched_hres = new Map<number, hresource_doc>(); // qbt user id -> hres
        for (const qusr of users) {
            const hres = hres_by_email.get(normalize_email(qusr.email)) ?? hres_by_email.get(normalize_email(qusr.username));
            if (hres) matched_hres.set(qusr.id, hres);
        }

        // Prefetch existing mappings for this page: by qbt_id (this QBT user already
        // linked) and by our_id (this hres already linked). linked_our is written
        // through below so two QBT users matching the same hres in one page don't both
        // insert — that would violate the unique (type, our_id) index and abort the txn.
        const [by_qbt_docs, by_our_docs] = await Promise.all([
            map_col.find({ type: "user", qbt_id: { $in: users.map((u) => u.id) } }).toArray(),
            map_col.find({ type: "user", our_id: { $in: [...new Set([...matched_hres.values()].map((h) => h._id))] } }).toArray(),
        ]);
        const linked_qbt = new Map(by_qbt_docs.map((m) => [m.qbt_id, m]));
        const linked_our = new Map(by_our_docs.map((m) => [m.our_id, m]));
        const inserts: AnyBulkWriteOperation<qbt_object_map>[] = [];

        for (const qusr of users) {
            // If we already have an entry for this user, skip it
            const existing = linked_qbt.get(qusr.id);
            if (existing) {
                ilog(`[usi] Already matched ${get_user_log_str(qusr)} to hres ${existing.our_id} - skipping`);
                continue;
            }

            const hres = matched_hres.get(qusr.id);
            if (!hres) {
                nomatches.push(qusr);
                continue;
            }

            const already_mapped = linked_our.get(hres._id);
            if (already_mapped) {
                ilog(`[usi] Found match ${get_hres_log_str(hres)} but hres already linked to ${already_mapped.qbt_id}`);
                continue;
            }

            const map_obj = create_qbt_object_map_item(qusr.id, hres._id, "user", new Date(qusr.last_modified));
            inserts.push({ insertOne: { document: map_obj } });
            linked_our.set(hres._id, map_obj); // write-through: claim this hres for the rest of the page
            ilog(`[usi] Bootstrap mapped hres ${get_hres_log_str(hres)} → ${get_user_log_str(qusr)}`);
        }

        if (inserts.length > 0) await mongo.with_transaction((session) => map_col.bulkWrite(inserts, { session }));
        if (!more) break;
        page++;
    }
    return nomatches;
}

export async function bootstrap_users(qbt: qbt_client): Promise<void> {
    if (get_sync_state().users.bootstrap_complete) return;
    ilog("[usi] Running bootstrap: matching users to hresources by email...");
    const all_hres = await mongo.get_hres().find({}).toArray();

    // Create faster lookup table
    const hres_by_email = new Map(all_hres.map((h) => [normalize_email(h.email), h]));
    // Do active users first, then non active users as we want our active ones to take priority
    const active_nomatches = await bootstrap_users_loop(qbt, hres_by_email, "yes");
    const archived_nomatches = await bootstrap_users_loop(qbt, hres_by_email, "no");
    for (const u of archived_nomatches) {
        ilog(`[usi] Could not find matching hres for archived ${get_user_log_str(u)}`);
    }

    for (let i = 0; i < active_nomatches.length; ++i) {
        const answer = await ask_yes_no(
            `[usi] Archive ${get_user_log_str(active_nomatches[i])} (${i + 1} of ${active_nomatches.length})?`
        );
        if (answer) {
            const result = await qbt.update_user(active_nomatches[i].id, { active: false });
            ilog(`[usi] Updated ${get_user_log_str(result)} to ${result.active ? "active" : "archived"}`);
        }
    }

    save_user_state({ bootstrap_complete: true });
    ilog("[usi] Bootstrap complete.");
}

async function process_hres_update(hres: hresource_doc, qbt: qbt_client): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_qbt_user(hres.tt_flags, hres.archived_info.on);
    const mapping = await map_col.findOne({ type: "user", our_id: hres._id });

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
    if (!usi.active) {
        ilog(
            `[jca] Starting sync - archiving any assignments for ${get_hres_log_str(hres)} (${get_user_log_str(usi)})`
        );
        await reconcile_jc_assignments_by_user(qbt, usi.id, new Set());
        return;
    }

    // Find awarded+active contracts where this hres is linked under an employee role.
    const role_filters = [...EMP_ROLE_KEYS].map((role) => ({
        [`assignments.${role}.emp_id`]: hres._id,
    }));
    const contracts = await mongo.get_conts().find({ $or: role_filters }).toArray();
    const cont_ids = contracts.filter((c) => is_active(c.archived_info.on) && is_awarded(c)).map((c) => c._id);

    const desired = new Set<number>();
    if (cont_ids.length > 0) {
        const cont_maps = await map_col.find({ type: "jobcode", our_id: { $in: cont_ids } }).toArray();
        const qbt_jc_ids = cont_maps.map((r) => r.qbt_id);
        const jcs = await fetch_all_by_ids(qbt_jc_ids, (ids) => qbt.fetch_jobcodes({ ids, active: "yes" }));
        jcs.forEach((jc) => desired.add(jc.id));
    }
    ilog(
        `[jca] Starting sync - ${desired.size} desired assignments for ${get_hres_log_str(hres)} (usi: ${get_user_log_str(usi)})`
    );
    await reconcile_jc_assignments_by_user(qbt, usi.id, desired);
}

export async function update_users_from_hres(qbt: qbt_client): Promise<void> {
    const state = get_sync_state();
    const since = state.users.last_synced ?? CURSOR_EPOCH;
    ilog(`[usi] Delta sync since ${since.toISOString()}`);

    // Query hresources modified since the cursor
    const changed = await mongo
        .get_hres()
        .find({ "last_update.on": { $gt: since } })
        .toArray();

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    for (let i = 0; i < changed.length; ++i) {
        const hres = changed[i];
        const at = hres.last_update.on;
        ilog(`[usi] Processing update for ${get_hres_log_str(hres)} (${i + 1} of ${changed.length})`);
        try {
            await process_hres_update(hres, qbt);
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
