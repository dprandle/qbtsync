import mongo from "./db";
import { qbt_client, fetch_all_by_ids } from "./qbt_client_interface";
import { qbt_object_map, qbt_object_type } from "./qbt_object_map";

// A qbt_object_map row joins a QBT object (qbt_id) to one of ours (our_id). The
// delta sync loops keep these healthy for *archives* (an archive bumps last_update,
// so the loop sees it), but they never revisit a row whose backing object was
// *hard-deleted* — a hard-deleted doc never reappears in a delta scan. This pass is
// the reconciliation safety net for exactly that gap. Policy (per the agreed design):
//   - QBT object missing (our present or not): drop the mapping. The normal sync
//     recreates it from our side on the next relevant change if it should exist.
//   - Our object missing, QBT present: reap the orphaned QBT object first
//     (timesheets are deleted, users/jobcodes archived), then drop the mapping.
// It runs inside the single sequential sync loop, so no other pass is mutating the
// map or QBT concurrently — that's what makes "missing" safe to act on without
// racing an in-flight create.

// Mappings are processed in chunks so QBT requests and bulk deletes stay within
// per-call limits (QBT caps id-list requests at 100).
const CLEANUP_CHUNK = 100;

function chunk<T>(arr: T[], size: number): T[][] {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
    return out;
}

type type_handler = {
    // Of the given qbt ids, which still exist on QBT. Uses active:"both" / by-ids so
    // an *archived* or *old* object is reported present (not mistaken for deleted).
    fetch_qbt_existing: (qbt: qbt_client, ids: number[]) => Promise<Set<number>>;
    // Of the given our ids, which still exist in the live collection. Absence means a
    // hard-delete (soft-deletes/archives stay in the live collection with a flag set).
    fetch_our_existing: (ids: string[]) => Promise<Set<string>>;
    // Reap orphaned QBT objects whose our-side is gone. Returns the ids actually
    // handled — only those get their mapping dropped, so a failed reap is retried next
    // run rather than leaving the mapping dangling-and-forgotten.
    reap_orphan_qbt: (qbt: qbt_client, ids: number[]) => Promise<number[]>;
};

const HANDLERS: Record<qbt_object_type, type_handler> = {
    user: {
        fetch_qbt_existing: (qbt, ids) =>
            qbt_id_set(fetch_all_by_ids(ids, (c) => qbt.fetch_users({ ids: c, active: "both" }))),
        fetch_our_existing: (ids) => our_id_set(mongo.get_hresources().find({ _id: { $in: ids } }, { projection: { _id: 1 } })),
        reap_orphan_qbt: (qbt, ids) => archive_each(ids, "user", (id) => qbt.update_user(id, { active: false })),
    },
    jobcode: {
        fetch_qbt_existing: (qbt, ids) =>
            qbt_id_set(fetch_all_by_ids(ids, (c) => qbt.fetch_jobcodes({ ids: c, active: "both" }))),
        fetch_our_existing: (ids) => our_id_set(mongo.get_conts().find({ _id: { $in: ids } }, { projection: { _id: 1 } })),
        reap_orphan_qbt: (qbt, ids) => archive_each(ids, "jobcode", (id) => qbt.update_jobcode(id, { active: false })),
    },
    timesheet: {
        fetch_qbt_existing: (qbt, ids) => qbt_id_set(fetch_all_by_ids(ids, (c) => qbt.fetch_timesheets({ ids: c }))),
        fetch_our_existing: (ids) => our_id_set(mongo.get_trecs().find({ _id: { $in: ids } }, { projection: { _id: 1 } })),
        // Timesheets are deleted (not archived), matching QBT semantics and the inbound
        // trec-removed branch. delete is bulk and all-or-nothing per batch.
        reap_orphan_qbt: async (qbt, ids) => {
            try {
                await qbt.delete_timesheets(ids);
                for (const id of ids) ilog(`[cleanup] timesheet: deleted orphan qbt timesheet ${id} (our time_record gone)`);
                return ids;
            } catch (err) {
                elog(`[cleanup] timesheet: failed to delete ${ids.length} orphan qbt timesheet(s):`, err);
                return [];
            }
        },
    },
};

async function qbt_id_set(items: Promise<{ id: number }[]>): Promise<Set<number>> {
    return new Set((await items).map((i) => i.id));
}

async function our_id_set(cursor: { toArray: () => Promise<{ _id: string }[]> }): Promise<Set<string>> {
    return new Set((await cursor.toArray()).map((d) => d._id));
}

// Archive QBT objects one at a time (no bulk update endpoint), collecting the ids
// that succeeded. A failure is logged and that id is left for the next run.
async function archive_each(
    ids: number[],
    label: string,
    archive: (id: number) => Promise<unknown>
): Promise<number[]> {
    const ok: number[] = [];
    for (const id of ids) {
        try {
            await archive(id);
            ilog(`[cleanup] ${label}: archived orphan qbt ${label} ${id} (our object gone)`);
            ok.push(id);
        } catch (err) {
            elog(`[cleanup] ${label}: failed to archive orphan qbt ${label} ${id}:`, err);
        }
    }
    return ok;
}

// Full scan of the qbt object map: bulk-load every mapping, then reconcile each type
// in chunks. Per-batch failures (a probe error, a failed reap, a failed delete) are
// logged and skipped so a localized problem can't abort the whole sweep.
export async function run_qbt_mapping_cleanup(qbt: qbt_client): Promise<void> {
    const map_col = mongo.get_qbt_map_objects();
    ilog("[cleanup] Starting qbt object map cleanup scan");

    const all = await map_col.find({}).toArray();
    const by_type = new Map<qbt_object_type, qbt_object_map[]>();
    for (const m of all) {
        const list = by_type.get(m.type);
        if (list) list.push(m);
        else by_type.set(m.type, [m]);
    }

    let removed = 0;
    let reaped = 0;
    for (const [type, maps] of by_type) {
        const handler = HANDLERS[type];
        for (const batch of chunk(maps, CLEANUP_CHUNK)) {
            let qbt_existing: Set<number>;
            let our_existing: Set<string>;
            try {
                [qbt_existing, our_existing] = await Promise.all([
                    handler.fetch_qbt_existing(qbt, batch.map((m) => m.qbt_id)),
                    handler.fetch_our_existing(batch.map((m) => m.our_id)),
                ]);
            } catch (err) {
                elog(`[cleanup] ${type}: failed to probe a batch of ${batch.length} - skipping batch:`, err);
                continue;
            }

            const remove_ids: string[] = []; // mapping _ids to delete
            const orphan_qbt_ids: number[] = []; // qbt ids whose our-side is gone (qbt still present)
            const orphan_map_id = new Map<number, string>(); // qbt_id -> mapping _id

            for (const m of batch) {
                const qbt_present = qbt_existing.has(m.qbt_id);
                const our_present = our_existing.has(m.our_id);
                if (qbt_present && our_present) continue; // healthy
                if (!qbt_present) {
                    remove_ids.push(m._id);
                    ilog(
                        `[cleanup] ${type}: dropping mapping ${m._id} - qbt ${m.qbt_id} missing, our ${m.our_id} ${our_present ? "present" : "missing"}`
                    );
                } else {
                    orphan_qbt_ids.push(m.qbt_id);
                    orphan_map_id.set(m.qbt_id, m._id);
                }
            }

            if (orphan_qbt_ids.length > 0) {
                const handled = await handler.reap_orphan_qbt(qbt, orphan_qbt_ids);
                for (const qid of handled) {
                    const mid = orphan_map_id.get(qid);
                    if (mid) remove_ids.push(mid);
                }
                reaped += handled.length;
            }

            if (remove_ids.length > 0) {
                try {
                    const res = await map_col.deleteMany({ _id: { $in: remove_ids } });
                    removed += res.deletedCount ?? 0;
                } catch (err) {
                    elog(`[cleanup] ${type}: failed to delete ${remove_ids.length} mapping(s):`, err);
                }
            }
        }
    }

    ilog(`[cleanup] Finished - removed ${removed} mapping(s), reaped ${reaped} orphaned qbt object(s)`);
}
