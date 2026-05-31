import mongo from "./db";
import { save_user_state, load_sync_state, cursor_progress, safe_cursor } from "./sync_state";
import { create_qbt_object_map_item } from "./qbt_object_map";
import { change_info, is_active } from "./uobj_common";
import { qbt_client, qbt_user, fetch_all_by_ids } from "./qbt_client_interface";
import { EMP_ROLE_KEYS, is_awarded, reconcile_user_assignments } from "./assignments";

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
    return `${hr.last_name}, ${hr.first_name} (${hr.email} - ${hr._id})`;
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
    active: boolean
): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    let page = 1;
    while (true) {
        const { items: users, more } = await qbt.fetch_users({ page, active });
        for (const qusr of users) {
            // If we already have an entry for this user, skip it
            const existing = await map_col.findOne({ type: "user", qbt_id: qusr.id });
            if (existing) continue;

            const normalized_usr_email = normalize_email(qusr.email);
            const normalized_username = normalize_email(qusr.username);

            let hres = hres_by_email.get(normalized_usr_email);
            if (!hres) hres = hres_by_email.get(normalized_username);
            if (!hres) {
                console.log("[users] Could not find matching hres for tsuser:", qusr);
                continue;
            }

            const already_mapped = await map_col.findOne({ type: "user", our_id: hres._id });
            if (already_mapped) {
                console.log(
                    `[users] Found match ${get_hres_log_str(hres)} but hres already linked to qbt user ${already_mapped.qbt_id}`
                );
                continue;
            }

            const map_obj = create_qbt_object_map_item(
                qusr.id,
                hres._id,
                "user",
                new Date(qusr.last_modified)
            );
            await map_col.insertOne(map_obj);
            console.log(
                `[users] Bootstrap mapped hres ${get_hres_log_str(hres)} → QBT user ${qusr.id} (${qusr.email})`
            );
        }
        if (!more) break;
        page++;
    }
}

async function bootstrap_users(qbt: qbt_client): Promise<void> {
    console.log("[users] Running bootstrap: matching QBT users to hresources by email...");
    const all_hres = await mongo.get_hres().find({}).toArray();

    // Create faster lookup table
    const hres_by_email = new Map(all_hres.map((h) => [normalize_email(h.email), h]));
    // Do active users first, then non active users as we want our active ones to take priority
    await bootstrap_users_loop(qbt, hres_by_email, true);
    await bootstrap_users_loop(qbt, hres_by_email, false);
    save_user_state({ bootstrap_complete: true });
    console.log("[users] Bootstrap complete.");
}

async function sync_hres(hres: hresource_doc, qbt: qbt_client): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_qbt_user(hres.tt_flags, hres.archived_info.on);
    const mapping = await map_col.findOne({ type: "user", our_id: hres._id });

    let usi: qbt_user | null = null;
    if (mapping) {
        usi = await qbt.fetch_user(mapping.qbt_id);
        const updates: Partial<qbt_user> = {};
        const norm_hr_email = normalize_email(hres.email);
        const norm_hr_phone = normalize_phone_number(hres.phone_number);
        if (want && !usi.active) updates.active = true;
        if (!want && usi.active) updates.active = false;
        if (usi.email != norm_hr_email) updates.email = norm_hr_email;
        if (usi.username != norm_hr_email) updates.username = norm_hr_email;
        if (usi.mobile_number != norm_hr_phone) updates.mobile_number = norm_hr_phone;
        if (usi.first_name != hres.first_name) updates.first_name = hres.first_name;
        if (usi.last_name != hres.last_name) updates.last_name = hres.last_name;
        if (Object.keys(updates).length > 0) {
            const new_usi = await qbt.update_user(usi.id, updates);
            console.log(
                `[users] Updated QBT user`,
                usi,
                `for hres ${get_hres_log_str(hres)} with`,
                updates,
                "resulting in",
                new_usi
            );
            usi = new_usi;
        }
    } else if (want) {
        // Create a new QBT user for this hresource
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
        console.log(`[users] Created QBT user`, usi, ` for hres ${get_hres_log_str(hres)}`);
    }

    // Reconcile this user's assignments now that its active state is settled.
    if (!usi) return;
    if (!usi.active) {
        await reconcile_user_assignments(qbt, usi.id, new Set());
        return;
    }

    // Find awarded+active contracts where this hres is linked under an employee role.
    const role_filters = [...EMP_ROLE_KEYS].map((role) => ({
        [`assignments.${role}.emp_id.source_str`]: hres._id,
    }));
    const contracts = await mongo.get_conts().find({ $or: role_filters }).toArray();
    const cont_ids = contracts.filter((c) => is_active(c.archived_info.on) && is_awarded(c)).map((c) => c._id);

    const desired = new Set<number>();
    if (cont_ids.length > 0) {
        const cont_maps = await map_col.find({ type: "jobcode", our_id: { $in: cont_ids } }).toArray();
        const qbt_jc_ids = cont_maps.map((r) => r.qbt_id);
        const jcs = await fetch_all_by_ids(qbt_jc_ids, (ids) => qbt.fetch_jobcodes({ ids }));
        for (const jc of jcs) {
            if (jc.active) desired.add(jc.id);
        }
    }
    await reconcile_user_assignments(qbt, usi.id, desired);
}

export async function sync_users(qbt: qbt_client): Promise<void> {
    const state = load_sync_state();

    if (!state.users.bootstrap_complete) {
        await bootstrap_users(qbt);
    }

    const since = state.users.last_synced ?? new Date(0);
    console.log(`[users] Delta sync since ${since.toISOString()}`);

    // Query hresources modified since the cursor
    const changed = await mongo
        .get_hres()
        .find({ "last_update.on": { $gt: since } })
        .toArray();

    const progress: cursor_progress = { latest_resolved: since, earliest_unresolved: null };
    for (const hres of changed) {
        const at = hres.last_update.on;
        try {
            await sync_hres(hres, qbt);
            if (at > progress.latest_resolved) progress.latest_resolved = at;
        } catch (err) {
            console.error(`[users] Error syncing hres ${hres._id}:`, err);
            if (!progress.earliest_unresolved || at < progress.earliest_unresolved) {
                progress.earliest_unresolved = at;
            }
        }
    }

    const latest = safe_cursor(progress, since);
    if (latest > since) {
        save_user_state({ last_synced: latest });
        console.log(`[users] Cursor advanced to ${latest.toISOString()}`);
    } else {
        console.log("[users] No hresource changes.");
    }
}
