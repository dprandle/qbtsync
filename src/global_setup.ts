import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import util from "node:util";

// Extend our request type to have any additional members we need and create some aliases for ilog guys
declare global {
  var ilog: any;
  var dlog: any;
  var wlog: any;
  var elog: any;
  var asrt: any;
}

// Tee all log output to a per-day file in addition to the terminal. The logs
// folder lives next to this file's output (dist/logs), so it follows the
// compiled binary rather than the cwd — run via `node dist/...`, not ts-node.
const log_dir = path.join(__dirname, "logs");
fs.mkdirSync(log_dir, { recursive: true });

// Derive the service name from the entry script: index -> "sync", otherwise the
// entry's basename (e.g. seed_mock_db).
const entry_file = require.main?.filename ?? "";
const entry_name = entry_file ? path.basename(entry_file).replace(/\.[^.]+$/, "") : "app";
const service = entry_name === "index" ? "sync" : entry_name;

function pad(n: number, len = 2) {
  return String(n).padStart(len, "0");
}

function date_str(d: Date) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function time_str(d: Date) {
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`;
}

// Open one stream and keep it; only roll over to a new file when the date
// changes, so each file holds a full day of activity.
let current_date = "";
let log_stream: fs.WriteStream | null = null;

function stream_for(d: Date) {
  const ds = date_str(d);
  if (ds !== current_date) {
    log_stream?.end();
    current_date = ds;
    log_stream = fs.createWriteStream(path.join(log_dir, `${ds}_${service}.log`), { flags: "a" });
  }
  return log_stream!;
}

function tee(original: (...args: any[]) => void, level: string) {
  return (...args: any[]) => {
    original(...args);
    const now = new Date();
    stream_for(now).write(`${time_str(now)} [${level}] ${util.format(...args)}\n`);
  };
}

globalThis.ilog = tee(console.log, "info");
globalThis.dlog = tee(console.debug, "debug");
globalThis.wlog = tee(console.warn, "warn");
globalThis.elog = tee(console.error, "error");
globalThis.asrt = console.assert;

dotenv.config();
