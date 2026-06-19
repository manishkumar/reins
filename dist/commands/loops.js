"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdLoops = cmdLoops;
const db_1 = require("../db");
const store_1 = require("../store");
const config_1 = require("../config");
const format_1 = require("./format");
const util_1 = require("../util");
function cmdLoops() {
    const db = (0, db_1.openDbReadOnly)();
    if (!db) {
        const note = (0, store_1.capabilityNote)();
        console.log(format_1.c.dim(note || "No runs recorded yet (.reins/runs.db doesn't exist)."));
        return 0;
    }
    const threshold = (0, config_1.loadConfig)().loopThreshold;
    const rows = db
        .prepare(`SELECT session_id, tool, MIN(input_summary) AS input_summary,
              COUNT(*) AS n, MAX(ts) AS last_ts
         FROM tool_calls
        GROUP BY session_id, input_hash
       HAVING n >= ?
        ORDER BY last_ts DESC`)
        .all(threshold);
    if (rows.length === 0) {
        console.log(format_1.c.green("No loops detected ") + format_1.c.dim(`(threshold: ${threshold} identical calls).`));
        return 0;
    }
    console.log(format_1.c.bold(`Loops detected `) + format_1.c.dim(`(same tool + input ≥ ${threshold}×)`));
    console.log("");
    let lastSession = "";
    for (const r of rows) {
        if (r.session_id !== lastSession) {
            console.log(format_1.c.cyan(r.session_id) + format_1.c.dim(`  · last ${r.last_ts}`));
            lastSession = r.session_id;
        }
        console.log(`  ${format_1.c.yellow("⟳")} ${format_1.c.dim(r.tool.padEnd(10))} ×${r.n}  ${(0, util_1.truncate)(r.input_summary, 80)}`);
    }
    console.log("");
    console.log(format_1.c.dim("Inspect a session in full:  reins lastrun <session-id>"));
    return 0;
}
