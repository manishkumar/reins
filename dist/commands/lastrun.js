"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdLastrun = cmdLastrun;
const db_1 = require("../db");
const store_1 = require("../store");
const format_1 = require("./format");
const util_1 = require("../util");
const config_1 = require("../config");
function cmdLastrun(args) {
    const db = (0, db_1.openDbReadOnly)();
    if (!db) {
        const note = (0, store_1.capabilityNote)();
        console.log(format_1.c.dim(note || "No runs recorded yet (.reins/runs.db doesn't exist)."));
        return 0;
    }
    // Allow `reins lastrun <session_id_prefix>` to inspect an older run.
    const wanted = args[0];
    let session;
    if (wanted) {
        session = db
            .prepare(`SELECT * FROM sessions WHERE id LIKE ? ORDER BY started DESC LIMIT 1`)
            .get(wanted + "%");
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
    printHeader(session, calls.length);
    console.log("");
    printTrajectory(calls, threshold);
    console.log("");
    printSummary(calls, threshold);
    return 0;
}
function printHeader(s, callCount) {
    const dur = duration(s.started, s.ended);
    console.log(format_1.c.bold("reins · last run"));
    console.log(`  ${format_1.c.dim("session")}  ${s.id}`);
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
        const denied = call.input_summary.startsWith("DENIED: ");
        const summary = denied ? call.input_summary.slice("DENIED: ".length) : call.input_summary;
        const looped = (counts.get(call.input_hash) ?? 0) >= threshold;
        let glyph;
        if (denied)
            glyph = format_1.c.red("⛔");
        else if (call.ok === 0)
            glyph = format_1.c.yellow("✗");
        else
            glyph = format_1.c.green(toolGlyph(call.tool));
        const tag = format_1.c.dim(call.tool.padEnd(10));
        const loopMark = looped ? format_1.c.yellow(" ⟳") : "";
        console.log(`  ${glyph} ${tag} ${(0, util_1.truncate)(summary, 92)}${loopMark}`);
    }
}
function printSummary(calls, threshold) {
    const writes = new Set();
    const commands = [];
    let denied = 0;
    let failed = 0;
    const counts = new Map();
    for (const call of calls) {
        const isDenied = call.input_summary.startsWith("DENIED: ");
        const summary = isDenied ? call.input_summary.slice(8) : call.input_summary;
        if (isDenied)
            denied++;
        else if (call.ok === 0)
            failed++;
        // Only count calls that actually ran — a denied write touched nothing.
        if (!isDenied && ["Write", "Edit", "MultiEdit", "NotebookEdit"].includes(call.tool)) {
            writes.add(summary);
        }
        if (call.tool === "Bash" && !isDenied)
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
