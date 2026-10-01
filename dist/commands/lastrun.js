"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdLastrun = cmdLastrun;
const db_1 = require("../db");
const store_1 = require("../store");
const format_1 = require("./format");
const util_1 = require("../util");
const config_1 = require("../config");
const holds_1 = require("../holds");
const sessionFace_1 = require("../sessionFace");
const claim_1 = require("../claim");
const footprint_1 = require("../footprint");
const paths_1 = require("../paths");
const holds_2 = require("../holds");
function cmdLastrun(args) {
    const db = (0, db_1.openDbReadOnly)();
    if (!db) {
        const note = (0, store_1.capabilityNote)();
        console.log(format_1.c.dim(note || "No runs recorded yet (.reins/runs.db doesn't exist)."));
        return 0;
    }
    // Allow `reins lastrun <session>` — id prefix, custom name, or mnemonic —
    // to inspect an older run (same resolution as `steer --session`).
    const wanted = args[0];
    let session;
    if (wanted) {
        const id = (0, db_1.matchSessions)(db, wanted)[0]; // most recent match wins here
        session = id
            ? db.prepare(`SELECT * FROM sessions WHERE id = ?`).get(id)
            : undefined;
    }
    else {
        session = db
            .prepare(`SELECT * FROM sessions ORDER BY started DESC LIMIT 1`)
            .get();
    }
    if (!session) {
        console.log(format_1.c.dim("No sessions recorded yet."));
        return 0;
    }
    const calls = db
        .prepare(`SELECT seq, tool, input_summary, input_hash, ok, ts FROM tool_calls WHERE session_id = ? ORDER BY seq ASC`)
        .all(session.id);
    const threshold = (0, config_1.loadConfig)().loopThreshold;
    printHeader(session, calls.length, (0, sessionFace_1.faceReader)(db)(session.id));
    console.log("");
    printTrajectory(calls, threshold);
    console.log("");
    printSummary(calls, threshold);
    printClaim(calls);
    printFootprint(calls);
    printDecisions(db, session.id);
    printAwaiting(session.id);
    return 0;
}
/**
 * A few-line rollup of the gate decisions table (deny/ask/hold/allow), not a
 * dump — `reins audit` is where the full chronological trail lives. Best-
 * effort read: an older runs.db without the decisions table (or any read
 * failure) just means the section is skipped.
 */
function printDecisions(db, sessionId) {
    if (!db)
        return;
    let rows;
    try {
        rows = (0, db_1.listDecisions)(db, { sessionId });
    }
    catch {
        return;
    }
    if (rows.length === 0)
        return;
    console.log("");
    console.log(format_1.c.bold("Gate decisions") + format_1.c.dim(`  (reins audit ${sessionId} for the full trail)`));
    const counts = new Map();
    for (const r of rows)
        counts.set(r.decision, (counts.get(r.decision) ?? 0) + 1);
    const order = ["deny", "ask", "hold", "allow"];
    const parts = order.filter((d) => counts.has(d)).map((d) => `${counts.get(d)} ${d}`);
    console.log(`  ${parts.join(format_1.c.dim(" · "))}`);
    const unresolved = rows.filter((r) => r.decision === "hold" && !r.resolution).length;
    if (unresolved > 0) {
        console.log(format_1.c.dim(`  ${unresolved} hold${unresolved === 1 ? "" : "s"} still awaiting a decision`));
    }
}
/**
 * Actions from this session still parked in the hold queue — read live from
 * .reins/pending (not the DB) so an approve/deny done a minute ago is already
 * reflected. This is the line the overnight-run user came for.
 */
function printAwaiting(sessionId) {
    let pending;
    try {
        pending = (0, holds_1.pendingForSession)(undefined, sessionId);
    }
    catch {
        return;
    }
    if (pending.length === 0)
        return;
    console.log("");
    console.log(format_1.c.cyan(`⏳ ${pending.length} action${pending.length === 1 ? "" : "s"} awaiting your approval`) +
        format_1.c.dim("   reins approve <id> · reins deny <id>"));
    for (const p of pending) {
        console.log(`    ${format_1.c.cyan(p.id)}  ${p.tool}  ${(0, util_1.truncate)((0, util_1.summarizeToolInput)(p.tool, p.input), 70)}`);
    }
}
/** What the session's own calls say about its work being done (src/claim.ts). */
function printClaim(calls) {
    const claim = (0, claim_1.checkClaim)(calls.map((r) => ({ tool: r.tool, summary: r.input_summary, ok: r.ok })));
    if (claim.verdict === "none")
        return;
    const tone = claim.verdict === "failed" ? format_1.c.red : claim.verdict === "verified" ? format_1.c.green : claim.verdict === "unknown" ? format_1.c.dim : format_1.c.yellow;
    console.log("");
    console.log(format_1.c.bold("Claim check") + format_1.c.dim("  (from this session's own calls; reports, never blocks)"));
    console.log(`  ${tone(claim.text)}`);
    if (claim.command)
        console.log(`  ${format_1.c.dim((0, util_1.truncate)(claim.command, 110))}`);
}
/** What the session edited and ran, to read beside what it was asked (src/footprint.ts). */
function printFootprint(calls) {
    const lines = (0, footprint_1.footprintLines)((0, footprint_1.footprint)(calls.map((r) => ({ tool: r.tool, summary: r.input_summary, ok: r.ok })), (0, holds_2.proposalWorkdir)((0, paths_1.resolveProjectDir)())));
    if (!lines.length)
        return;
    console.log("");
    console.log(format_1.c.bold("Footprint") + format_1.c.dim("  (facts from the captured calls; whether it matches the ask is yours to judge)"));
    for (const l of lines)
        console.log(l.startsWith("  ") ? format_1.c.dim("  " + l) : "  " + l);
}
function printHeader(s, callCount, face) {
    const dur = duration(s.started, s.ended);
    console.log(format_1.c.bold("reins · last run") + (face.label === face.name ? "" : "  " + format_1.c.cyan(face.label)));
    console.log(`  ${format_1.c.dim("session")}  ${face.name} ${format_1.c.dim("·")} ${s.id}`);
    if (face.branch)
        console.log(`  ${format_1.c.dim("branch")}   ${face.branch}`);
    if (face.asked)
        console.log(`  ${format_1.c.dim("asked")}    ${(0, util_1.truncate)(face.asked, 160)}`);
    if (s.repo)
        console.log(`  ${format_1.c.dim("repo")}     ${s.repo}`);
    console.log(`  ${format_1.c.dim("when")}     ${s.started ?? "?"}${dur ? format_1.c.dim(`  (${dur})`) : ""}`);
    const outcome = s.final_outcome ?? (s.ended ? "ended" : format_1.c.yellow("still running / not stopped"));
    console.log(`  ${format_1.c.dim("outcome")}  ${outcome}`);
    const meta = [`${callCount} tool calls`];
    if (s.total_tokens != null)
        meta.push(`${groupThousands(s.total_tokens)} tokens`);
    if (s.total_cost != null)
        meta.push(`$${s.total_cost.toFixed(4)}`);
    console.log(`  ${format_1.c.dim("totals")}   ${meta.join(format_1.c.dim(" · "))}`);
}
function printTrajectory(calls, threshold) {
    if (calls.length === 0) {
        console.log(format_1.c.dim("  (no tool calls recorded)"));
        return;
    }
    console.log(format_1.c.bold("Trajectory"));
    // Precompute repeat counts for loop marking.
    const counts = new Map();
    for (const call of calls)
        counts.set(call.input_hash, (counts.get(call.input_hash) ?? 0) + 1);
    for (const call of calls) {
        const gate = gateDecision(call.input_summary);
        const summary = gate ? call.input_summary.slice(gate.length + 2) : call.input_summary;
        const looped = (counts.get(call.input_hash) ?? 0) >= threshold;
        let glyph;
        if (gate === "DENIED")
            glyph = format_1.c.red("⛔");
        else if (gate === "ASKED")
            glyph = format_1.c.yellow("✋");
        else if (gate === "HELD")
            glyph = format_1.c.cyan("⏳");
        else if (gate === "APPROVED")
            glyph = format_1.c.green("✓");
        else if (gate === "REFUSED")
            glyph = format_1.c.red("✋");
        else if (call.ok === 0)
            glyph = format_1.c.yellow("✗");
        else
            glyph = format_1.c.green(toolGlyph(call.tool));
        const tag = format_1.c.dim(call.tool.padEnd(10));
        const loopMark = looped ? format_1.c.yellow(" ⟳") : "";
        console.log(`  ${glyph} ${tag} ${(0, util_1.truncate)(summary, 92)}${loopMark}`);
    }
}
/** The gate-decision prefix of a recorded row, if any ("DENIED", "HELD", …). */
function gateDecision(summary) {
    const m = /^(DENIED|ASKED|HELD|APPROVED|REFUSED): /.exec(summary);
    return m ? m[1] : null;
}
function printSummary(calls, threshold) {
    const writes = new Set();
    const commands = [];
    let denied = 0;
    let held = 0;
    let failed = 0;
    const counts = new Map();
    for (const call of calls) {
        const gate = gateDecision(call.input_summary);
        const summary = gate ? call.input_summary.slice(gate.length + 2) : call.input_summary;
        if (gate === "DENIED")
            denied++;
        else if (gate === "HELD")
            held++;
        else if (!gate && call.ok === 0)
            failed++;
        // Only count calls that actually ran — a gated write touched nothing.
        if (!gate && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.tool)) {
            writes.add(summary);
        }
        if (call.tool === "Bash" && !gate)
            commands.push(summary);
        const prev = counts.get(call.input_hash);
        counts.set(call.input_hash, { n: (prev?.n ?? 0) + 1, tool: call.tool, summary });
    }
    const loops = [...counts.values()].filter((v) => v.n >= threshold);
    console.log(format_1.c.bold("Summary"));
    console.log(`  ${format_1.c.green("files touched")}  ${writes.size}`);
    if (writes.size > 0)
        for (const w of writes)
            console.log(`    ${format_1.c.dim("·")} ${(0, util_1.truncate)(w, 88)}`);
    console.log(`  ${format_1.c.magenta("commands run")}   ${commands.length}`);
    if (denied > 0)
        console.log(`  ${format_1.c.red("blocked")}        ${denied} ${format_1.c.dim("(guard vetoes)")}`);
    if (held > 0)
        console.log(`  ${format_1.c.cyan("parked")}         ${held} ${format_1.c.dim("(hold rules)")}`);
    if (failed > 0)
        console.log(`  ${format_1.c.yellow("failed calls")}   ${failed}`);
    if (loops.length > 0) {
        console.log(`  ${format_1.c.yellow("loops")}          ${loops.length} ${format_1.c.dim("(repeated ≥ " + threshold + "×)")}`);
        for (const l of loops)
            console.log(`    ${format_1.c.yellow("⟳")} ${l.tool} ×${l.n}: ${format_1.c.dim((0, util_1.truncate)(l.summary, 70))}`);
    }
}
function toolGlyph(tool) {
    switch (tool) {
        case "Write":
            return "✎";
        case "Edit":
        case "MultiEdit":
        case "NotebookEdit":
            return "✏";
        case "Bash":
            return "▶";
        case "Read":
        case "NotebookRead":
            return "👁";
        case "Glob":
        case "Grep":
            return "🔍";
        default:
            return "•";
    }
}
/** Stable thousands grouping (avoids locale-specific output like "1,83,007"). */
function groupThousands(n) {
    return n.toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}
function duration(start, end) {
    if (!start || !end)
        return "";
    const ms = new Date(end).getTime() - new Date(start).getTime();
    if (!isFinite(ms) || ms < 0)
        return "";
    const s = Math.round(ms / 1000);
    if (s < 60)
        return `${s}s`;
    const m = Math.floor(s / 60);
    return `${m}m ${s % 60}s`;
}
