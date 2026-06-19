"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdSessions = cmdSessions;
const db_1 = require("../db");
const store_1 = require("../store");
const format_1 = require("./format");
/** List recent sessions in this project — useful when several agents have run. */
function cmdSessions(args) {
    const limit = parseLimit(args) ?? 15;
    const db = (0, db_1.openDbReadOnly)();
    if (!db) {
        console.log(format_1.c.dim((0, store_1.capabilityNote)() || "No runs recorded yet (.reins/runs.db doesn't exist)."));
        return 0;
    }
    const rows = db
        .prepare(`SELECT s.id, s.started, s.ended, s.final_outcome,
              COUNT(t.seq) AS calls, MAX(t.ts) AS last_ts
         FROM sessions s
         LEFT JOIN tool_calls t ON t.session_id = s.id
        GROUP BY s.id
        ORDER BY COALESCE(MAX(t.ts), s.started) DESC
        LIMIT ?`)
        .all(limit);
    if (rows.length === 0) {
        console.log(format_1.c.dim("No sessions recorded yet."));
        return 0;
    }
    console.log(format_1.c.bold(`Recent sessions `) + format_1.c.dim(`(most recent first, max ${limit})`));
    console.log("");
    for (const r of rows) {
        const status = r.ended
            ? format_1.c.green(r.final_outcome || "ended")
            : format_1.c.yellow("running");
        const when = (r.last_ts || r.started || "").replace("T", " ").replace(/\..*/, "");
        console.log(`  ${format_1.c.cyan(shortId(r.id))}  ${status.padEnd(20)} ${format_1.c.dim(`${r.calls} calls`)}  ${format_1.c.dim(when)}`);
    }
    console.log("");
    console.log(format_1.c.dim("Full trajectory of one:  reins lastrun <session-id>"));
    return 0;
}
function shortId(id) {
    // First 8 chars are plenty unique within a project and copy cleanly into
    // `reins lastrun <prefix>` (which matches on prefix).
    return id.length > 8 ? id.slice(0, 8) : id;
}
function parseLimit(args) {
    const i = args.findIndex((a) => a === "-n" || a === "--limit");
    if (i >= 0 && args[i + 1]) {
        const n = parseInt(args[i + 1], 10);
        if (Number.isFinite(n) && n > 0)
            return n;
    }
    return undefined;
}
