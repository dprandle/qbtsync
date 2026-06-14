import "./global_setup";
import * as readline from "readline";
import { qbt_api_client } from "./qbt_client";
import { qbt_query_filter } from "./qbt_client_interface";

// A small dev REPL for reading the *current* state of QBT objects without logging
// into TSheets' click-heavy UI. It always talks to live QBT (a fresh qbt_api_client),
// regardless of QBT_ENV — the whole point is to see what QBT actually holds right now.
//
// At the prompt you can:
//   - type a type code (ts/js/jsa/usr) to switch which endpoint you query
//   - type a number id                -> queries that single id
//   - type a comma-separated id list  -> queries those ids
//   - type an object {...}            -> used verbatim as QBT query params
// Results print as JSON: a single match prints as the lone object, multiple (or zero)
// print as the array.

const qbt = new qbt_api_client();

type type_code = "ts" | "js" | "jsa" | "usr";

const TYPES: Record<type_code, { label: string; query: (f: qbt_query_filter) => Promise<unknown[]> }> = {
    ts: { label: "timesheets", query: (f) => qbt.query_timesheets(f) },
    js: { label: "jobcodes", query: (f) => qbt.query_jobcodes(f) },
    jsa: { label: "jobcode_assignments", query: (f) => qbt.query_jobcode_assignments(f) },
    usr: { label: "users", query: (f) => qbt.query_users(f) },
};

let current: type_code = "ts";

// Accept an object literal the way you'd type it at a JS console — unquoted keys,
// single quotes, trailing commas — not just strict JSON. This is a local dev tool
// reading the operator's own input, so evaluating the literal is acceptable here.
function parse_object_literal(src: string): qbt_query_filter {
    const val = Function(`"use strict"; return (${src});`)();
    if (typeof val !== "object" || val === null || Array.isArray(val)) {
        throw new Error("expected an object literal like { active: \"both\" }");
    }
    return val as qbt_query_filter;
}

function is_id_list(input: string): boolean {
    return /^\d+(\s*,\s*\d+)*$/.test(input);
}

function print_result(items: unknown[]): void {
    // One match -> print just that object at top level; otherwise print the array.
    const out = items.length === 1 ? items[0] : items;
    ilog(JSON.stringify(out, null, 2));
}

async function handle(input: string): Promise<void> {
    const line = input.trim();
    if (!line) return;

    if (line in TYPES) {
        current = line as type_code;
        ilog(`switched to ${current} (${TYPES[current].label})`);
        return;
    }

    let filter: qbt_query_filter;
    if (line.startsWith("{")) {
        filter = parse_object_literal(line);
    } else if (is_id_list(line)) {
        filter = { ids: line.replace(/\s+/g, "") };
    } else {
        elog(
            `Unrecognized input. Type a type code (${Object.keys(TYPES).join("/")}), a number id, ` +
                `a comma-separated id list, or an object literal {...}.`
        );
        return;
    }

    const items = await TYPES[current].query(filter);
    print_result(items);
}

async function main(): Promise<void> {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const set_prompt = () => rl.setPrompt(`qbt[${current}]> `);

    ilog("QBT live query tool. Types: " + Object.entries(TYPES).map(([k, v]) => `${k}=${v.label}`).join(", "));
    ilog("Switch type with ts/js/jsa/usr; query with an id, id list, or {object}. Ctrl-D or 'exit' to quit.");

    set_prompt();
    rl.prompt();

    rl.on("line", async (line) => {
        const trimmed = line.trim();
        if (trimmed === "exit" || trimmed === "quit") {
            rl.close();
            return;
        }
        try {
            await handle(line);
        } catch (err) {
            elog(`Error: ${err instanceof Error ? err.message : String(err)}`);
        }
        set_prompt();
        rl.prompt();
    });

    await new Promise<void>((resolve) => rl.on("close", resolve));
}

main().catch((err) => {
    elog(err);
    process.exit(1);
});
