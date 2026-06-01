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

// Tee all log output to a file in addition to the terminal. Every entrypoint
// imports this module, so any command (start/dev/migrate/reset/seed) is covered.
const log_dir = path.resolve(__dirname, "..", "logs");
fs.mkdirSync(log_dir, { recursive: true });
const log_file = path.join(log_dir, "app.log");
const log_stream = fs.createWriteStream(log_file, { flags: "a" });

function tee(original: (...args: any[]) => void, level: string) {
  return (...args: any[]) => {
    original(...args);
    const ts = new Date().toISOString();
    log_stream.write(`${ts} [${level}] ${util.format(...args)}\n`);
  };
}

globalThis.ilog = tee(console.log, "info");
globalThis.dlog = tee(console.debug, "debug");
globalThis.wlog = tee(console.warn, "warn");
globalThis.elog = tee(console.error, "error");
globalThis.asrt = console.assert;

dotenv.config();
