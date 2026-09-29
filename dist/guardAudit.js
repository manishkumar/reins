"use strict";
// Was the guard right?
//
// `reins audit <session>` answers "what did the gate decide". This answers the
// question after it: of everything the gate stopped, how much *deserved* it.
// Bypass reporting (src/bypass.ts) already computes half the answer live — it
// notices when a denied command's intent runs anyway — but it clears its ledger
// at the end of each run, so nobody can ever look back across a project and see
// the pattern. The DB kept the rows the whole time.
//
// Two verdicts, both deterministic, neither a guess:
//
//   stale        The recorded command does not match today's shipped rules at
//                all. That denial is not a judgement call that went the wrong
//                way; it is damage from a rule that was already fixed upstream.
//                (This is the freeze in fix(policy) seen from the other end: a
//                real repo took 14 of these before anyone noticed.)
//   worked around  A near-identical call executed later in the same session.
//                The veto didn't hold — either the rule is too broad for this
//                repo and the agent routed around it, or it needs to be a hold.
//
// Same containment measure as live bypass detection, so the two never disagree.
// Read-only, and reporting only: nothing here can influence a gate decision
// (invariants 1, 4 and 12). Capture is optional, so an install without SQLite
// simply has nothing to audit — it says so and exits 0.
Object.defineProperty(exports, "__esModule", { value: true });
exports.collectDenials = collectDenials;
exports.firesUnder = firesUnder;
exports.attributeWorkarounds = attributeWorkarounds;
exports.auditGuards = auditGuards;
exports.humanGap = humanGap;
const guards_1 = require("./guards");
const bypass_1 = require("./bypass");
/** Gate rows wear their decision as a prefix in tool_calls.input_summary. */
const GATE_PREFIX = /^(DENIED|ASKED|HELD|APPROVED|REFUSED):\s*/;
/** ...and the rule that fired as a suffix. Both predate the decisions table. */
const GUARD_SUFFIX = /\s*\[guard:([^\]]+)\]\s*(\[hold:[^\]]+\])?\s*$/;
/**
 * Every denial this project has recorded, oldest first.
 *
 * Read from both places they live. `decisions` is the clean table, but it only
 * exists from 0.4 — a project that has been running longer keeps its earlier
 * denials solely as tagged `tool_calls` rows, and those are exactly the history
 * worth auditing. Both are written in the same breath with the same timestamp
 * (see recordDecision), so (session, ts) dedupes them exactly.
 */
function collectDenials(db) {
    const seen = new Set();
    const out = [];
    const add = (session_id, ts, tool, summary, rule_id) => {
        const key = session_id + "|" + ts;
        if (seen.has(key))
            return;
        seen.add(key);
        out.push({
            session_id,
            ts,
            tool,
            summary,
            rule_id,
            truncated: summary.endsWith("…"),
            firesLocal: false,
            firesShipped: false,
        });
    };
    try {
        const rows = db
            .prepare(`SELECT session_id, ts, tool, input_summary, rule_id
           FROM decisions WHERE decision = 'deny' ORDER BY ts`)
            .all();
        for (const r of rows)
            add(r.session_id, r.ts, r.tool, r.input_summary, r.rule_id || "?");
    }
    catch {
        // Pre-0.4 runs.db has no decisions table; the tool_calls sweep below is the
        // whole history there.
    }
    try {
        const rows = db
            .prepare(`SELECT session_id, ts, tool, input_summary
           FROM tool_calls WHERE input_summary LIKE 'DENIED:%' ORDER BY ts`)
            .all();
        for (const r of rows) {
            const m = GUARD_SUFFIX.exec(r.input_summary);
            const summary = r.input_summary.replace(GATE_PREFIX, "").replace(GUARD_SUFFIX, "");
            add(r.session_id, r.ts, r.tool, summary, m ? m[1] : "?");
        }
    }
    catch {
        /* no tool_calls to read — leave whatever decisions gave us */
    }
    out.sort((a, b) => a.ts.localeCompare(b.ts));
    return out;
}
/**
 * Re-run a recorded denial against a rule set.
 *
 * The input is reconstructed from the summary, which is lossy in two known
 * ways: whitespace (including newlines) was collapsed at capture, and long
 * commands were truncated. Both can only make a match LESS likely, never more —
 * so a "would still fire" verdict is solid, and a "wouldn't fire" verdict on a
 * truncated row is the one to mark. cwd is deliberately not supplied: without
 * it, relative-path exemptions don't widen, which again errs toward "still
 * fires". Under-claiming staleness is the right direction to be wrong in.
 */
function firesUnder(rules, tool, summary) {
    const input = tool === "Bash" ? { command: summary } : { file_path: summary };
    const file = { rules };
    try {
        return (0, guards_1.checkGuards)(file, tool, input) !== null;
    }
    catch {
        return true; // can't tell — assume the denial stands rather than accuse a rule
    }
}
/**
 * Find the call that undid each denial, if there was one.
 *
 * Same session, same window, same containment threshold as live detection, so
 * this can't contradict what the Stop hook already told the user. Gate rows are
 * skipped: a HELD or ASKED row is not something that executed.
 */
function attributeWorkarounds(db, denials) {
    const bySession = new Map();
    for (const d of denials) {
        if (d.tool !== "Bash")
            continue; // bypass tracking is command-shaped
        let calls = bySession.get(d.session_id);
        if (!calls) {
            calls = db
                .prepare(`SELECT session_id, ts, tool, input_summary, ok
             FROM tool_calls WHERE session_id = ? AND tool = 'Bash'
              AND (ok IS NULL OR ok = 1) ORDER BY ts`)
                .all(d.session_id);
            calls = calls.filter((c) => !GATE_PREFIX.test(c.input_summary));
            bySession.set(d.session_id, calls);
        }
        const deniedFp = (0, bypass_1.fingerprint)(d.summary);
        if (deniedFp.length === 0)
            continue;
        const t0 = Date.parse(d.ts);
        let best;
        for (const call of calls) {
            const gapMs = Date.parse(call.ts) - t0;
            if (!(gapMs > 0 && gapMs <= bypass_1.BYPASS_WINDOW_MS))
                continue;
            const score = (0, bypass_1.retryScore)(deniedFp, (0, bypass_1.fingerprint)(call.input_summary));
            if (score === 0)
                continue;
            if (!best || score > best.score) {
                best = { ts: call.ts, summary: call.input_summary, score, gapMs };
            }
        }
        if (best)
            d.workaround = best;
    }
}
/** The whole audit: denials, their verdicts, rolled up per rule. */
function auditGuards(db, cwd) {
    const denials = collectDenials(db);
    attributeWorkarounds(db, denials);
    const local = (0, guards_1.loadGuards)(cwd).rules;
    for (const d of denials) {
        d.firesLocal = firesUnder(local, d.tool, d.summary);
        d.firesShipped = firesUnder(guards_1.DEFAULT_RULES, d.tool, d.summary);
    }
    const byRule = new Map();
    const sessions = new Set();
    for (const d of denials) {
        sessions.add(d.session_id);
        const v = byRule.get(d.rule_id) ??
            {
                rule_id: d.rule_id,
                fired: 0,
                stale: 0,
                workedAround: 0,
                fastestWorkaroundMs: null,
                samples: [],
            };
        v.fired++;
        if (!d.firesShipped)
            v.stale++;
        if (d.workaround) {
            v.workedAround++;
            if (v.fastestWorkaroundMs === null || d.workaround.gapMs < v.fastestWorkaroundMs) {
                v.fastestWorkaroundMs = d.workaround.gapMs;
            }
        }
        v.samples.push(d);
        byRule.set(d.rule_id, v);
    }
    // Lead with the rule that cost the most: worked-around denials first (the
    // guard didn't hold), then stale ones (the guard shouldn't have fired).
    const rules = [...byRule.values()].sort((a, b) => b.workedAround - a.workedAround || b.stale - a.stale || b.fired - a.fired);
    for (const v of rules) {
        v.samples.sort((a, b) => Number(!!b.workaround) - Number(!!a.workaround) || a.ts.localeCompare(b.ts));
    }
    return {
        denials: denials.length,
        sessions: sessions.size,
        stale: denials.filter((d) => !d.firesShipped).length,
        workedAround: denials.filter((d) => d.workaround).length,
        // Only worth telling someone to upgrade if their CURRENT rules are what's
        // producing the noise. A project that already upgraded still sees its old
        // denials in the history; that's not a call to action.
        policyBehind: denials.some((d) => d.firesLocal && !d.firesShipped),
        rules,
    };
}
function humanGap(ms) {
    return ms < 1000 ? `${ms}ms` : ms < 60000 ? `${Math.round(ms / 1000)}s` : `${Math.round(ms / 60000)}m`;
}
