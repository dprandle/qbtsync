import mongo from "./db";
import { save_user_state, load_sync_state } from "./sync_state";
import { create_qbt_object_map_item, QBT_ACTIVE, QBT_ARCHIVED } from "./qbt_object_map";
import { change_info, is_active } from "./uobj_common";
import { qbt_client, qbt_user } from "./qbt_client_interface";
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

function find_matching_hres(qusr: qbt_user): Promise<hresource_doc | null> {
    const escapeRegex = (s = "") => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

    const email = qusr.email?.trim();
    const username = qusr.username?.trim();
    const phone = qusr.mobile_number?.trim();
    const firstName = qusr.first_name?.trim();
    const lastName = qusr.last_name?.trim();

    const or = [];

    if (email) {
        or.push({
            email: { $regex: new RegExp(`^${escapeRegex(email)}$`, "i") },
        });
    }

    if (username) {
        or.push({
            username: { $regex: new RegExp(`^${escapeRegex(username)}$`, "i") },
        });
    }

    if (phone) {
        or.push({
            phone: phone, // or normalized version if needed
        });
    }

    if (firstName && lastName) {
        or.push({
            first_name: { $regex: new RegExp(`^${escapeRegex(firstName)}$`, "i") },
            last_name: { $regex: new RegExp(`^${escapeRegex(lastName)}$`, "i") },
        });
    }

    return mongo.get_hres().findOne({ $or: or });
}

async function bootstrap_users(qbt: qbt_client): Promise<void> {
    console.log("[users] Running bootstrap: matching QBT users to hresources by email...");
    const map_col = mongo.get_qbt_map_objects();

    const all_hres = await mongo.get_hres().find({}).toArray();

    let page = 1;
    while (true) {
        const { items: users, more } = await qbt.fetch_users({ page });
        for (const qusr of users) {
            const existing = await map_col.findOne({ type: "user", qbt_id: qusr.id });
            if (existing) continue;

            const hres = await find_matching_hres(qusr);
            if (!hres) continue;

            const already_mapped = await map_col.findOne({ type: "user", our_id: hres._id });
            if (already_mapped) continue;
            const map_obj = create_qbt_object_map_item(
                qusr.id,
                hres._id,
                "user",
                qusr.active ? QBT_ACTIVE : QBT_ARCHIVED,
                new Date(qusr.last_modified)
            );
            await map_col.insertOne(map_obj);
            console.log(`[users] Bootstrap mapped hres ${hres._id} → QBT user ${qusr.id} (${qusr.email})`);
        }
        if (!more) break;
        page++;
    }

    save_user_state({ bootstrap_complete: true });
    console.log("[users] Bootstrap complete.");
}

async function sync_hres(hres_id: string, tt_flags: number, archived_on: Date, qbt: qbt_client): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    const want = should_have_qbt_user(tt_flags, archived_on);
    const mapping = await map_col.findOne({ type: "user", our_id: hres_id });

    if (want) {
        if (!mapping) {
            // Create a new QBT user for this hresource
            const hres = await mongo.get_hres().findOne({ _id: hres_id });
            if (!hres) return;
            const created = await qbt.create_user({
                username: hres.email,
                email: hres.email,
                first_name: hres.first_name,
                last_name: hres.last_name,
                mobile_number: hres.phone_number,
            });
            const map_obj = create_qbt_object_map_item(
                created.id,
                hres_id,
                "user",
                QBT_ACTIVE,
                new Date(created.last_modified)
            );
            await map_col.insertOne(map_obj);
            console.log(`[users] Created QBT user ${created.id} for hres ${hres_id}`);
        } else if ((mapping.qbt_status ?? QBT_ACTIVE) !== QBT_ACTIVE) {
            await qbt.update_user(mapping.qbt_id, { active: true });
            await map_col.updateOne({ _id: mapping._id }, { $set: { qbt_status: QBT_ACTIVE } });
            console.log(`[users] Reactivated QBT user ${mapping.qbt_id} for hres ${hres_id}`);
        }
    } else {
        if (mapping && (mapping.qbt_status ?? QBT_ACTIVE) !== QBT_ARCHIVED) {
            // Archive the QBT user; keep the mapping for potential reactivation
            await qbt.update_user(mapping.qbt_id, { active: false });
            await map_col.updateOne({ _id: mapping._id }, { $set: { qbt_status: QBT_ARCHIVED } });
            console.log(`[users] Archived QBT user ${mapping.qbt_id} for hres ${hres_id}`);
        }
    }

    // Reconcile this user's assignments now that its active state is settled.
    const user_map = await map_col.findOne({ type: "user", our_id: hres_id });
    if (!user_map) return;
    if ((user_map.qbt_status ?? QBT_ACTIVE) !== QBT_ACTIVE) {
        await reconcile_user_assignments(qbt, user_map.qbt_id, new Set());
        return;
    }

    // Find awarded+active contracts where this hres is linked under an employee role.
    const role_filters = [...EMP_ROLE_KEYS].map((role) => ({
        [`assignments.${role}.emp_id.source_str`]: hres_id,
    }));
    const contracts = await mongo.get_conts().find({ $or: role_filters }).toArray();
    const desired = new Set<number>();
    for (const cont of contracts) {
        if (!is_active(cont.archived_info.on) || !is_awarded(cont)) continue;
        const jc_map = await map_col.findOne({ type: "jobcode", our_id: cont._id });
        if (jc_map && (jc_map.qbt_status ?? QBT_ACTIVE) === QBT_ACTIVE) desired.add(jc_map.qbt_id);
    }
    await reconcile_user_assignments(qbt, user_map.qbt_id, desired);
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

    let latest = since;
    for (const hres of changed) {
        try {
            await sync_hres(hres._id, hres.tt_flags, hres.archived_info.on, qbt);
        } catch (err) {
            console.error(`[users] Error syncing hres ${hres._id}:`, err);
        }
        if (hres.last_update.on > latest) latest = hres.last_update.on;
    }

    if (latest > since) {
        save_user_state({ last_synced: latest });
        console.log(`[users] Cursor advanced to ${latest.toISOString()}`);
    } else {
        console.log("[users] No hresource changes.");
    }
}
