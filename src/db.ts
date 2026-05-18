import { MongoClient, Db, Collection } from "mongodb";
import { config } from "./config";
import { time_record, sync_state, qbt_object_map } from "./types";

let client: MongoClient;
let db: Db;

export async function connect(): Promise<void> {
    client = new MongoClient(config.mongo_uri);
    await client.connect();
    db = client.db(config.mongo_db_name);
    console.log(`Connected to MongoDB: ${config.mongo_db_name}`);

    await qbt_object_map_col().createIndex({ type: 1, qbt_id: 1 }, { unique: true });
}

export async function disconnect(): Promise<void> {
    await client.close();
}

export function time_records_col(): Collection<time_record> {
    return db.collection<time_record>("time_records");
}

export function qbt_object_map_col(): Collection<qbt_object_map> {
    return db.collection<qbt_object_map>("qbt_object_map");
}

export function sync_state_col(): Collection<sync_state> {
    return db.collection<sync_state>("sync_state");
}

export async function load_sync_state(): Promise<sync_state> {
    const state = await sync_state_col().findOne({ _id: "qbt_sync" });
    if (state) return state;

    const initial: sync_state = {
        _id: "qbt_sync",
        full_import_complete: false,
        last_synced: null,
        full_import_page: 1,
    };
    await sync_state_col().insertOne(initial);
    return initial;
}

export async function save_sync_state(update: Partial<Omit<sync_state, "_id">>): Promise<void> {
    await sync_state_col().updateOne({ _id: "qbt_sync" }, { $set: update }, { upsert: true });
}
