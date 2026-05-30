import { MongoClient, Db, Collection } from "mongodb";
import { config } from "./config";
import {
    time_record,
    qbt_object_map,
    hresource_doc,
    contract_route_doc,
    contract_role_doc,
    qbt_user,
    qbt_jobcode,
    qbt_jobcode_assignment,
    qbt_timesheet,
} from "./types";

let client: MongoClient;
let db: Db;
let mock_db: Db;

export async function connect(): Promise<void> {
    client = new MongoClient(config.mongo_uri);
    await client.connect();
    db = client.db(config.mongo_db_name);
    mock_db = client.db(config.mock_qbt_db_name);
    console.log(`Connected to MongoDB: ${config.mongo_db_name} (mock: ${config.mock_qbt_db_name})`);

    await get_qbt_map_collection().createIndex({ type: 1, qbt_id: 1 }, { unique: true });
    await get_qbt_map_collection().createIndex({ type: 1, our_id: 1 }, { unique: true });
}

export async function disconnect(): Promise<void> {
    await client.close();
}

export function get_trec_collection(): Collection<time_record> {
    return db.collection<time_record>("time_records");
}

export function get_qbt_map_collection(): Collection<qbt_object_map> {
    return db.collection<qbt_object_map>("qbt_object_map");
}

export function get_hres_collection(): Collection<hresource_doc> {
    return db.collection<hresource_doc>("hresource");
}

export function get_cont_collection(): Collection<contract_route_doc> {
    return db.collection<contract_route_doc>("contract_route");
}

// Mock QBT collections (dev mode only — stored in a separate DB)

export function get_mock_users_collection(): Collection<qbt_user> {
    return mock_db.collection<qbt_user>("users");
}

export function get_mock_jobcodes_collection(): Collection<qbt_jobcode> {
    return mock_db.collection<qbt_jobcode>("jobcodes");
}

export function get_mock_assignments_collection(): Collection<qbt_jobcode_assignment> {
    return mock_db.collection<qbt_jobcode_assignment>("jobcode_assignments");
}

export function get_mock_timesheets_collection(): Collection<qbt_timesheet> {
    return mock_db.collection<qbt_timesheet>("timesheets");
}
