import { randomUUID } from "crypto";
import { save_user_state, load_sync_state } from "./sync_state";
import { hresources_col, qbt_object_map_col } from "./db";
import { QbtClient } from "./qbt_client_interface";

// Bit 0 of tt_flags — mirrors TIME_TRACKING_APP in hres.h
const TIME_TRACKING_APP = 1;

// INVALID_DATETIME sentinel stored by UberMail for un-archived documents
const INVALID_DATETIME = new Date("0001-01-01T00:00:00.000Z");

function should_have_qbt_user(tt_flags: number, archived_on: Date): boolean {
    const is_active = archived_on.getTime() <= INVALID_DATETIME.getTime();
    const tracking_enabled = (tt_flags & TIME_TRACKING_APP) !== 0;
    return is_active && tracking_enabled;
}

async function bootstrap_users(qbt: QbtClient): Promise<void> {
    console.log("[users] Running bootstrap: matching QBT users to hresources by email...");
    const map_col = qbt_object_map_col();

    let page = 1;
    while (true) {
        const { users, more } = await qbt.fetch_users({ page });
        for (const qbt_user of users) {
            if (!qbt_user.email) continue;

            const existing = await map_col.findOne({ type: "user", qbt_id: qbt_user.id });
            if (existing) continue;

            const hres = await hresources_col().findOne(
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

async function sync_hres(hres_id: string, tt_flags: number, archived_on: Date, qbt: QbtClient): Promise<void> {
    const map_col = qbt_object_map_col();
    const want = should_have_qbt_user(tt_flags, archived_on);
    const mapping = await map_col.findOne({ type: "user", our_id: hres_id });

    if (want) {
        if (!mapping) {
            // Create a new QBT user for this hresource
            const hres = await hresources_col().findOne({ _id: hres_id });
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
                qbt_modified: new Date(created.last_modified),
                our_updated_at: null,
            });
            console.log(`[users] Created QBT user ${created.id} for hres ${hres_id}`);
        } else {
            // Ensure the QBT user is active
            const { users } = await qbt.fetch_users({ page: 1 });
            const qbt_user = users.find((u) => u.id === mapping.qbt_id);
            if (qbt_user && !qbt_user.active) {
                await qbt.set_user_active(mapping.qbt_id, true);
                console.log(`[users] Reactivated QBT user ${mapping.qbt_id} for hres ${hres_id}`);
            }
        }
    } else {
        if (mapping) {
            // Archive the QBT user; keep the mapping for potential reactivation
            await qbt.set_user_active(mapping.qbt_id, false);
            console.log(`[users] Archived QBT user ${mapping.qbt_id} for hres ${hres_id}`);
        }
    }
}

export async function sync_users(qbt: QbtClient): Promise<void> {
    const state = load_sync_state();

    if (!state.users.bootstrap_complete) {
        await bootstrap_users(qbt);
    }

    const since = state.users.last_synced ?? new Date(0);
    console.log(`[users] Delta sync since ${since.toISOString()}`);

    // Query hresources modified since the cursor
    const changed = await hresources_col()
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
