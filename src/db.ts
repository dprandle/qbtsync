import { MongoClient, Db, Collection } from "mongodb";
import { config } from "./config";
import { time_record, qbt_object_map } from "./types";

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


