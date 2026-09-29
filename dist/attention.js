"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.EVENT_WINDOW_MS = void 0;
exports.collectAttention = collectAttention;
exports.describeInput = describeInput;
const db_1 = require("./db");
const holds_1 = require("./holds");
const bypass_1 = require("./bypass");
/**
 * A parked hold is listed at any age because it is still waiting. A breach or
 * bypass is a past event with no acknowledgement, so it stays at the top for a
 * week and then moves to a count; `reins audit --guards` keeps the full record.
 */
exports.EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;
function collectAttention(repo, db, now = new Date()) {
    const holds = (0, holds_1.listPending)(repo).map((p) => ({
        id: p.id,
        sessionId: p.session_id,
        tool: p.tool,
        input: describeInput(p),
        ruleId: p.rule_id,
        reason: p.reason,
        ts: p.ts,
    }));
    const events = [];
    if (db) {
        try {
            for (const d of (0, db_1.listDecisions)(db, { limit: 100_000 })) {
                if (d.decision !== "breach" && d.decision !== "bypass")
                    continue;
                events.push({
                    kind: d.decision,
                    sessionId: d.session_id,
                    ts: d.ts,
                    tool: d.tool,
                    summary: d.input_summary.replace(/^(BREACH|BYPASS): /, ""),
                    ruleId: d.rule_id || (d.hold_id ? `hold ${d.hold_id}` : ""),
                    detail: d.rule_reason,
                });
            }
        }
        catch {
            /* an older runs.db without the decisions table: nothing to add */
        }
    }
    else {
        for (const r of (0, bypass_1.readLedger)(repo)) {
            if (!r.bypassed_ts)
                continue;
            events.push({
                kind: "bypass",
                sessionId: r.session_id,
                ts: r.bypassed_ts,
                tool: r.tool,
                summary: r.bypassed_by ?? "",
                ruleId: r.rule_id,
                detail: `Denied: ${r.summary}`,
            });
        }
    }
    const cutoff = now.getTime() - exports.EVENT_WINDOW_MS;
    const recent = events.filter((e) => !(Date.parse(e.ts) < cutoff));
    // Breaches first (a hold that didn't hold), then newest first.
    recent.sort((a, b) => (a.kind !== b.kind ? (a.kind === "breach" ? -1 : 1) : a.ts < b.ts ? 1 : -1));
    return { holds, events: recent, olderEvents: events.length - recent.length };
}
/** What the approver is signing off on, in the form they'd recognize it. */
function describeInput(p) {
    const i = p.input;
    if (i && typeof i === "object") {
        if (typeof i.command === "string")
            return i.command;
        if (typeof i.file_path === "string")
            return i.file_path;
    }
    try {
        return JSON.stringify(p.input, null, 2) ?? "";
    }
    catch {
        return String(p.input);
    }
}
