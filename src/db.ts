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

    await qbt_object_map_col().createIndex({ type: 1, qbt_id: 1 }, { unique: true });
    await qbt_object_map_col().createIndex({ type: 1, our_id: 1 }, { unique: true });
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

export function hresources_col(): Collection<hresource_doc> {
    return db.collection<hresource_doc>("hresource");
}

export function contracts_col(): Collection<contract_route_doc> {
    return db.collection<contract_route_doc>("contract_route");
}

export function contract_roles_col(): Collection<contract_role_doc> {
    return db.collection<contract_role_doc>("contract_role");
}

// Mock QBT collections (dev mode only — stored in a separate DB)

export function mock_qbt_users_col(): Collection<qbt_user> {
    return mock_db.collection<qbt_user>("users");
}

export function mock_qbt_jobcodes_col(): Collection<qbt_jobcode> {
    return mock_db.collection<qbt_jobcode>("jobcodes");
}

export function mock_qbt_assignments_col(): Collection<qbt_jobcode_assignment> {
    return mock_db.collection<qbt_jobcode_assignment>("jobcode_assignments");
}

export function mock_qbt_timesheets_col(): Collection<qbt_timesheet> {
    return mock_db.collection<qbt_timesheet>("timesheets");
}
