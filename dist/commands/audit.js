"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdAudit = cmdAudit;
const db_1 = require("../db");
const store_1 = require("../store");
const guardAudit_1 = require("../guardAudit");
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
    const guardRollup = args.includes("--guards");
    const positional = args.filter((a) => !a.startsWith("--"));
    const db = (0, db_1.openDbReadOnly)();
    if (guardRollup && db)
        return guardsReport(db, asJson);
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
/**
 * `reins audit --guards` — every denial this project ever recorded, scored.
 *
 * Written to be read top-down by someone deciding whether to keep a rule. The
 * two headline numbers are deliberately the uncomfortable ones: how many
 * denials today's shipped rules wouldn't even produce, and how many the agent
 * simply walked around. A guard that is wrong every time is worse than absent.
 */
function guardsReport(db, asJson) {
    const report = (0, guardAudit_1.auditGuards)(db);
    if (asJson) {
        console.log(JSON.stringify(report, null, 2));
        return 0;
    }
    if (report.denials === 0) {
        console.log(format_1.c.dim("No guard denials recorded yet — nothing to audit."));
        return 0;
    }
    console.log(format_1.c.bold("reins · guard audit") +
        format_1.c.dim(`  ${report.denials} denial${report.denials === 1 ? "" : "s"} across ${report.sessions} session${report.sessions === 1 ? "" : "s"}`));
    console.log("");
    for (const v of report.rules) {
        const bits = [`${v.fired} fired`];
        if (v.stale > 0)
            bits.push(format_1.c.yellow(`${v.stale} wouldn't fire under today's shipped rules`));
        if (v.workedAround > 0) {
            const fastest = v.fastestWorkaroundMs !== null ? `, fastest ${(0, guardAudit_1.humanGap)(v.fastestWorkaroundMs)}` : "";
            bits.push(format_1.c.red(`${v.workedAround} worked around${fastest}`));
        }
        console.log(`  ${format_1.c.bold(v.rule_id.padEnd(24))} ${bits.join(format_1.c.dim(" · "))}`);
        for (const s of v.samples.slice(0, 3)) {
            const mark = s.workaround ? format_1.c.red("↻") : s.firesShipped ? format_1.c.dim("·") : format_1.c.yellow("~");
            console.log(`      ${mark} ${format_1.c.dim(day(s.ts))} ${(0, util_1.truncate)(s.summary, 68)}`);
            if (s.workaround) {
                console.log(format_1.c.dim(`        ran anyway ${(0, guardAudit_1.humanGap)(s.workaround.gapMs)} later: `) +
                    (0, util_1.truncate)(s.workaround.summary, 52));
            }
        }
        if (v.samples.length > 3)
            console.log(format_1.c.dim(`      … and ${v.samples.length - 3} more`));
        console.log("");
    }
    // The two readings, spelled out — the numbers above are only useful if the
    // reader knows which lever each one points at.
    if (report.stale > 0) {
        console.log(format_1.c.yellow("~") +
            ` ${report.stale} of ${report.denials} denials came from rules that have since been fixed upstream.`);
        if (report.policyBehind) {
            console.log(format_1.c.dim("  Your policy still produces them — run `reins policy upgrade`."));
        }
        else {
            console.log(format_1.c.dim("  Your policy has already moved on; these are history."));
        }
    }
    if (report.workedAround > 0) {
        console.log(format_1.c.red("↻") +
            ` ${report.workedAround} denial${report.workedAround === 1 ? "" : "s"} ${report.workedAround === 1 ? "was" : "were"} undone by a near-identical call that ran anyway.`);
        console.log(format_1.c.dim("  Guards match form, not intent. Narrow the rule, or make it a `--hold` that actually parks."));
    }
    if (report.stale === 0 && report.workedAround === 0) {
        console.log(format_1.c.green("✓") + " Every recorded denial still stands under today's rules, and none was worked around.");
    }
    // Said plainly rather than left as a footnote: these verdicts are computed
    // from what capture stored, which collapsed whitespace and cut long commands.
    const truncated = report.rules.reduce((n, v) => n + v.samples.filter((s) => s.truncated).length, 0);
    if (truncated > 0) {
        console.log(format_1.c.dim(`  (${truncated} command${truncated === 1 ? " was" : "s were"} truncated at capture — those verdicts read a prefix, not the whole command.)`));
    }
    return 0;
}
function day(ts) {
    const d = new Date(ts);
    return isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ts;
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
