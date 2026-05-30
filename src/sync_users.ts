import { randomUUID } from "crypto";
import { save_user_state, load_sync_state } from "./sync_state";
import { get_hres_collection, get_cont_collection, get_qbt_map_collection } from "./db";
import { QBT_ACTIVE, QBT_ARCHIVED } from "./types";
import { qbt_client } from "./qbt_client_interface";
import { EMP_ROLE_KEYS, is_active, is_awarded, reconcile_user_assignments } from "./assignments";

// Bit 0 of tt_flags — mirrors TIME_TRACKING_APP in hres.h
const TIME_TRACKING_APP = 1;

function should_have_qbt_user(tt_flags: number, archived_on: Date): boolean {
    const tracking_enabled = (tt_flags & TIME_TRACKING_APP) !== 0;
    return is_active(archived_on) && tracking_enabled;
}

async function bootstrap_users(qbt: qbt_client): Promise<void> {
    console.log("[users] Running bootstrap: matching QBT users to hresources by email...");
    const map_col = get_qbt_map_collection();

    let page = 1;
    while (true) {
        const { users, more } = await qbt.fetch_users({ page });
        for (const qbt_user of users) {
            if (!qbt_user.email) continue;

            const existing = await map_col.findOne({ type: "user", qbt_id: qbt_user.id });
            if (existing) continue;

            const hres = await get_hres_collection().findOne(
                { email: { $regex: new RegExp(`^${qbt_user.email.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`, "i") } }
            );
            if (!hres) continue;

            const already_mapped = await map_col.findOne({ type: "user", our_id: hres._id });
            if (already_mapped) continue;

            await map_col.insertOne({
                _id: randomUUID(),
                qbt_id: qbt_user.id,
                our_id: hres._id,
                type: "user",
                qbt_status: qbt_user.active ? QBT_ACTIVE : QBT_ARCHIVED,
                qbt_modified: new Date(qbt_user.last_modified),
                our_updated_at: null,
            });
            console.log(`[users] Bootstrap mapped hres ${hres._id} → QBT user ${qbt_user.id} (${qbt_user.email})`);
        }
        if (!more) break;
        page++;
    }

    await save_user_state({ bootstrap_complete: true });
    console.log("[users] Bootstrap complete.");
}

async function sync_hres(hres_id: string, tt_flags: number, archived_on: Date, qbt: qbt_client): Promise<void> {
    const map_col = get_qbt_map_collection();
    const want = should_have_qbt_user(tt_flags, archived_on);
    const mapping = await map_col.findOne({ type: "user", our_id: hres_id });

    if (want) {
        if (!mapping) {
            // Create a new QBT user for this hresource
            const hres = await get_hres_collection().findOne({ _id: hres_id });
            if (!hres) return;
            const created = await qbt.create_user({
                username: hres.email,
                email: hres.email,
                first_name: hres.first_name,
                last_name: hres.last_name,
            });
            await map_col.insertOne({
                _id: randomUUID(),
                qbt_id: created.id,
                our_id: hres_id,
                type: "user",
                qbt_status: QBT_ACTIVE,
                qbt_modified: new Date(created.last_modified),
                our_updated_at: null,
            });
            console.log(`[users] Created QBT user ${created.id} for hres ${hres_id}`);
        } else if ((mapping.qbt_status ?? QBT_ACTIVE) !== QBT_ACTIVE) {
            await qbt.set_user_active(mapping.qbt_id, true);
            await map_col.updateOne({ _id: mapping._id }, { $set: { qbt_status: QBT_ACTIVE } });
            console.log(`[users] Reactivated QBT user ${mapping.qbt_id} for hres ${hres_id}`);
        }
    } else {
        if (mapping && (mapping.qbt_status ?? QBT_ACTIVE) !== QBT_ARCHIVED) {
            // Archive the QBT user; keep the mapping for potential reactivation
            await qbt.set_user_active(mapping.qbt_id, false);
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
    const contracts = await get_cont_collection().find({ $or: role_filters }).toArray();
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
    const changed = await get_hres_collection()
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
        await save_user_state({ last_synced: latest });
        console.log(`[users] Cursor advanced to ${latest.toISOString()}`);
    } else {
        console.log("[users] No hresource changes.");
    }
}
