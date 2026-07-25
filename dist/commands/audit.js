"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdAudit = cmdAudit;
const db_1 = require("../db");
const store_1 = require("../store");
const format_1 = require("./format");
const util_1 = require("../util");
/**
 * `reins audit [session]` — the chronological trail of gate decisions (deny /
 * ask / hold / allow) for one session, with how each was ultimately resolved.
 * Scriptable via --json (raw decisions rows), same shape `listDecisions`
 * returns — this is on the roadmap, so the JSON is the contract, not an
 * afterthought.
 */
function cmdAudit(args) {
    const asJson = args.includes("--json");
    const positional = args.filter((a) => a !== "--json");
    const db = (0, db_1.openDbReadOnly)();
    if (!db) {
        const note = (0, store_1.capabilityNote)() || "No runs recorded yet (.reins/runs.db doesn't exist).";
        if (asJson) {
            console.log(JSON.stringify({ error: note }));
            return 0;
        }
        console.log(format_1.c.dim(note));
        return 0;
    }
    const wanted = positional[0];
    let sessionId;
    if (wanted) {
        sessionId = (0, db_1.matchSessions)(db, wanted)[0]; // most recent match wins, like lastrun
        if (!sessionId) {
            const msg = `No session matches "${wanted}".`;
            if (asJson) {
                console.log(JSON.stringify({ error: msg }));
                return 1;
            }
            console.error(format_1.c.red(msg) + format_1.c.dim("  (reins sessions lists them)"));
            return 1;
        }
    }
    else {
        const row = db
            .prepare(`SELECT id FROM sessions ORDER BY started DESC LIMIT 1`)
            .get();
        sessionId = row?.id;
    }
    if (!sessionId) {
        if (asJson) {
            console.log(JSON.stringify([]));
            return 0;
        }
        console.log(format_1.c.dim("No sessions recorded yet."));
        return 0;
    }
    const rows = (0, db_1.listDecisions)(db, { sessionId });
    if (asJson) {
        console.log(JSON.stringify(rows, null, 2));
        return 0;
    }
    if (rows.length === 0) {
        console.log(format_1.c.dim(`No gate decisions recorded for session ${sessionId}.`));
        return 0;
    }
    console.log(format_1.c.bold("reins · audit") + format_1.c.dim(`  session ${sessionId}`));
    console.log("");
    for (const r of rows) {
        console.log(
        // Truncate the tool name, don't just pad it: MCP tool names
        // (mcp__stripe__create_refund) are long enough to shear the columns off
        // the right of the terminal, and the queue is meant to be skimmed.
        `  ${format_1.c.dim(time(r.ts))}  ${glyph(r.decision)} ${(0, util_1.truncate)(r.tool, 18).padEnd(18)} ` +
            `${(0, util_1.truncate)(r.input_summary, 56).padEnd(56)}  ${format_1.c.dim(`[${r.rule_id}]`)}${resolutionTag(r)}`);
    }
    return 0;
}
function glyph(decision) {
    switch (decision) {
        case "deny":
            return format_1.c.red("⛔");
        case "ask":
            return format_1.c.yellow("✋");
        case "hold":
            return format_1.c.cyan("⏳");
        case "allow":
            return format_1.c.green("✓");
        default:
            return "•";
    }
}
function resolutionTag(r) {
    if (!r.resolution)
        return r.decision === "hold" ? format_1.c.dim("  (awaiting decision)") : "";
    const word = r.resolution === "approved" ? format_1.c.green("approved") : format_1.c.red("denied");
    return format_1.c.dim("  → ") + word + format_1.c.dim(` by ${r.resolver ?? "?"}`);
}
function time(ts) {
    const d = new Date(ts);
    return isFinite(d.getTime()) ? d.toISOString().slice(11, 19) : ts;
}
