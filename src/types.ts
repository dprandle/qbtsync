// QuickBooks Time API types

export type qbt_timesheet = {
  id: number;
  user_id: number;
  jobcode_id: number;
  start: string; // ISO 8601
  end: string; // ISO 8601
  duration: number; // seconds
  date: string; // YYYY-MM-DD
  type: "regular" | "pto";
  active: boolean;
  locked: number;
  notes: string;
  last_modified: string; // ISO 8601
  tz: string;
  customfields: Record<string, string>;
};

export type qbt_timesheets_response = {
  results: {
    timesheets: Record<string, qbt_timesheet>;
  };
  more: boolean;
  supplemental_data?: {
    users?: Record<string, unknown>;
    jobcodes?: Record<string, unknown>;
  };
};

export type qbt_user = {
  id: number;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  active: boolean;
  employee_role: string;
  last_modified: string; // ISO 8601
};

export type qbt_users_response = {
  results: {
    users: Record<string, qbt_user>;
  };
  more: boolean;
};

export type qbt_jobcode = {
  id: number;
  parent_id: number;
  name: string;
  active: boolean;
  last_modified: string; // ISO 8601
};

export type qbt_jobcodes_response = {
  results: {
    jobcodes: Record<string, qbt_jobcode>;
  };
  more: boolean;
};

export type qbt_jobcode_assignment = {
  id: number;
  user_id: number;
  jobcode_id: number;
  active: boolean;
  last_modified: string; // ISO 8601
};

export type qbt_jobcode_assignments_response = {
  results: {
    jobcode_assignments: Record<string, qbt_jobcode_assignment>;
  };
  more: boolean;
};

// MongoDB document types

// When time record schema is changed (if it is) we must migrate the items in the DB - this keeps track of what schema our code is expecting
const TIME_RECORD_SCHEMA_VERSION = 1;

export type change_info = {
  by: string;
  on: Date;
};

export type qbt_object_type = "timesheet" | "user" | "jobcode";

export type qbt_object_map = {
  _id: string;
  qbt_id: number;
  our_id: string;
  type: qbt_object_type;
  qbt_modified: Date;
  // Set by the service whenever it writes a time_record from an inbound sync or outbound push.
  // Used by the outbound sync to detect desktop-originated edits (time_record.updated_at > our_updated_at).
  our_updated_at: Date | null;
};

export type time_record = {
  _id: string;
  custom_params: Record<string, string>;
  archived_info: change_info;
  last_update: change_info;
  created: change_info;
  schema_version: number;
  hrid: string; // hresource id
  cont_id: string; // contract id
  notes: string;
  start: Date;
  end: Date;
  Date: Date;
};

// Minimal projections of UberMail MongoDB documents (only fields the sync service queries)

export type hresource_doc = {
  _id: string;
  first_name: string;
  last_name: string;
  email: string;
  tt_flags: number;
  archived_info: { on: Date };
  last_update: { on: Date };
};

export type contract_route_doc = {
  _id: string;
  route_num: string;
  // keys are role_id source_str; each value is an array of crole_link objects
  assignments: Record<string, Array<{ emp_id: { source_str: string } }>>;
  archived_info: { on: Date };
  last_update: { on: Date };
};

export type contract_role_doc = {
  _id: string;
  tags: Array<{ tag_key: string }>;
};

// Sync state (nested per sync type, stored in sync_state.json)

export type timesheet_sync_state = {
  full_import_complete: boolean;
  last_synced: Date | null; // inbound cursor: QBT modified_since
  full_import_page: number;
  outbound_last_synced: Date | null; // outbound cursor: time_records updated_at
};

export type user_sync_state = {
  bootstrap_complete: boolean; // true once initial email-match bootstrap has run
  last_synced: Date | null; // hresource last_update.on cursor
};

export type jobcode_sync_state = {
  bootstrap_complete: boolean; // true once initial name-match bootstrap has run
  last_synced: Date | null; // contract_route last_update.on cursor
};

export type sync_state = {
  timesheets: timesheet_sync_state;
  users: user_sync_state;
  jobcodes: jobcode_sync_state;
};
