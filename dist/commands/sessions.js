"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdSessions = cmdSessions;
const db_1 = require("../db");
const store_1 = require("../store");
const holds_1 = require("../holds");
const sessionFace_1 = require("../sessionFace");
const format_1 = require("./format");
/** List recent sessions in this project — useful when several agents have run. */
function cmdSessions(args) {
    const limit = parseLimit(args) ?? 15;
    const db = (0, db_1.openDbReadOnly)();
    if (!db) {
        console.log(format_1.c.dim((0, store_1.capabilityNote)() || "No runs recorded yet (.reins/runs.db doesn't exist)."));
        return 0;
    }
    const hasName = (0, db_1.hasSessionNameColumn)(db);
    const hasTranscript = (0, db_1.hasSessionTranscriptColumn)(db);
    const rows = db
        .prepare(`SELECT s.id, ${hasName ? "s.name, " : ""}${hasTranscript ? "s.transcript, " : ""}s.started, s.ended, s.final_outcome,
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
    // Live hold-queue counts per session, so a run that ended with parked
    // actions is visibly waiting on YOU, right in the list.
    const holdCounts = new Map();
    try {
        for (const p of (0, holds_1.listPending)()) {
            holdCounts.set(p.session_id, (holdCounts.get(p.session_id) ?? 0) + 1);
        }
    }
    catch {
        /* queue unreadable — show sessions without chips */
    }
    console.log(format_1.c.bold(`Recent sessions `) + format_1.c.dim(`(most recent first, max ${limit})`));
    console.log("");
    for (const r of rows) {
        const status = r.ended
            ? format_1.c.green(r.final_outcome || "ended")
            : format_1.c.yellow("running");
        const when = (r.last_ts || r.started || "").replace("T", " ").replace(/\..*/, "");
        const holds = holdCounts.get(r.id);
        const holdChip = holds ? format_1.c.cyan(`  ⏳ ${holds} awaiting approval`) : "";
        // What the session is about leads: it's what humans scan by. The name
        // and short id that lastrun/steer accept follow on the line below.
        const face = (0, sessionFace_1.sessionFace)(r.id, r.name, r.transcript);
        const head = pad(clip((0, sessionFace_1.headOf)(face, r.id), 34), 34);
        console.log(`  ${format_1.c.cyan(head)}  ${status.padEnd(20)} ${format_1.c.dim(`${r.calls} calls`)}  ${format_1.c.dim(when)}${holdChip}`);
        const about = (0, sessionFace_1.aboutOf)(face, r.id);
        if (about)
            console.log(`    ${format_1.c.dim(about)}`);
    }
    console.log("");
    console.log(format_1.c.dim("Full trajectory of one:  reins lastrun <session-id>"));
    console.log(format_1.c.dim('Name one for easier aim: reins name <session> "<label>"'));
    if (holdCounts.size > 0)
        console.log(format_1.c.dim("Review parked actions:   reins pending"));
    return 0;
}
function clip(s, width) {
    return s.length > width ? s.slice(0, width - 1) + "…" : s;
}
/** Pad the PLAIN string before coloring (color codes have zero display width). */
function pad(s, width) {
    return s.length >= width ? s : s + " ".repeat(width - s.length);
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
