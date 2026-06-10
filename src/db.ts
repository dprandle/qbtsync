import { MongoClient, Db, Collection, ClientSession } from "mongodb";
import { config } from "./config";
import { type time_record } from "./sync_timesheets";
import { type qbt_object_map } from "./qbt_object_map";
import { type hresource_doc } from "./sync_users";
import { type contract_route_doc } from "./sync_jobcodes";
import { type invitation_doc } from "./invite_server";
import {
    mock_qbt_user,
    mock_qbt_jobcode,
    mock_qbt_jobcode_assignment,
    mock_qbt_timesheet,
} from "./qbt_client_interface";

let client: MongoClient;
let db: Db;
let mock_db: Db;

async function connect(): Promise<void> {
    client = new MongoClient(config.mongo_uri);
    await client.connect();
    db = client.db(config.mongo_db_name);
    mock_db = client.db(config.mock_qbt_db_name);
    ilog(`[startup] Connected to MongoDB: ${config.mongo_db_name} (mock: ${config.mock_qbt_db_name})`);
}

async function disconnect(): Promise<void> {
    await client.close();
}

// Runs fn inside a multi-document transaction. withTransaction may re-invoke fn on
// transient errors, so fn must be safe to retry (ours just re-issues buffered bulk
// ops). Requires a replica set / mongos — standalone mongod will throw.
async function with_transaction<T>(fn: (session: ClientSession) => Promise<T>): Promise<T> {
    return client.withSession((session) => session.withTransaction((s) => fn(s)));
}

function get_db(): Db {
    return db;
}

function get_mock_db(): Db {
    return mock_db;
}

function get_trecs(): Collection<time_record> {
    return db.collection<time_record>("time_record");
}

function get_qbt_map_objects(): Collection<qbt_object_map> {
    return db.collection<qbt_object_map>("qbt_object_map");
}

function get_hresources(): Collection<hresource_doc> {
    return db.collection<hresource_doc>("hresource");
}

function get_conts(): Collection<contract_route_doc> {
    return db.collection<contract_route_doc>("contract_route");
}

// Mock QBT collections (dev mode only — stored in a separate DB)

// Not QBT data — written by our invite server as invites go out. Lives in the
// mock DB so it's cleared alongside the rest on seed and visible there in dev.
function get_mock_invitations(): Collection<invitation_doc> {
    return mock_db.collection<invitation_doc>("invitations");
}

function get_mock_users(): Collection<mock_qbt_user> {
    return mock_db.collection<mock_qbt_user>("users");
}

function get_mock_jobcodes(): Collection<mock_qbt_jobcode> {
    return mock_db.collection<mock_qbt_jobcode>("jobcodes");
}

function get_mock_assignments(): Collection<mock_qbt_jobcode_assignment> {
    return mock_db.collection<mock_qbt_jobcode_assignment>("jobcode_assignments");
}

function get_mock_timesheets(): Collection<mock_qbt_timesheet> {
    return mock_db.collection<mock_qbt_timesheet>("timesheets");
}

function get_mock_deleted_timesheets(): Collection<mock_qbt_timesheet> {
    return mock_db.collection<mock_qbt_timesheet>("timesheets-deleted");
}

const mongo = {
    connect,
    disconnect,
    with_transaction,
    get_db,
    get_mock_db,
    get_trecs,
    get_qbt_map_objects,
    get_hresources,
    get_conts,
    get_mock_invitations,
    get_mock_users,
    get_mock_jobcodes,
    get_mock_assignments,
    get_mock_timesheets,
    get_mock_deleted_timesheets,
};

export default mongo;
