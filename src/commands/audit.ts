import { openDbReadOnly, matchSessions, listDecisions, DecisionListRow } from "../db";
import { capabilityNote, SqlDb } from "../store";
import { auditGuards, humanGap } from "../guardAudit";
import { c } from "./format";
import { truncate } from "../util";

/**
 * `reins audit [session]` — the chronological trail of gate decisions (deny /
 * ask / hold / allow) for one session, with how each was ultimately resolved.
 * Scriptable via --json (raw decisions rows), same shape `listDecisions`
 * returns — this is on the roadmap, so the JSON is the contract, not an
 * afterthought.
 */
export function cmdAudit(args: string[]): number {
  const asJson = args.includes("--json");
  const guardRollup = args.includes("--guards");
  const positional = args.filter((a) => !a.startsWith("--"));

  const db = openDbReadOnly();
  if (guardRollup && db) return guardsReport(db, asJson);
  if (!db) {
    const note = capabilityNote() || "No runs recorded yet (.reins/runs.db doesn't exist).";
    if (asJson) {
      console.log(JSON.stringify({ error: note }));
      return 0;
    }
    console.log(c.dim(note));
    return 0;
  }

  const wanted = positional[0];
  let sessionId: string | undefined;
  if (wanted) {
    sessionId = matchSessions(db, wanted)[0]; // most recent match wins, like lastrun
    if (!sessionId) {
      const msg = `No session matches "${wanted}".`;
      if (asJson) {
        console.log(JSON.stringify({ error: msg }));
        return 1;
      }
      console.error(c.red(msg) + c.dim("  (reins sessions lists them)"));
      return 1;
    }
  } else {
    const row = db
      .prepare(`SELECT id FROM sessions ORDER BY started DESC LIMIT 1`)
      .get() as { id: string } | undefined;
    sessionId = row?.id;
  }

  if (!sessionId) {
    if (asJson) {
      console.log(JSON.stringify([]));
      return 0;
    }
    console.log(c.dim("No sessions recorded yet."));
    return 0;
  }

  const rows = listDecisions(db, { sessionId });

  if (asJson) {
    console.log(JSON.stringify(rows, null, 2));
    return 0;
  }

  if (rows.length === 0) {
    console.log(c.dim(`No gate decisions recorded for session ${sessionId}.`));
    return 0;
  }

  console.log(c.bold("reins · audit") + c.dim(`  session ${sessionId}`));
  console.log("");
  for (const r of rows) {
    console.log(
      // Truncate the tool name, don't just pad it: MCP tool names
      // (mcp__stripe__create_refund) are long enough to shear the columns off
      // the right of the terminal, and the queue is meant to be skimmed.
      `  ${c.dim(time(r.ts))}  ${glyph(r.decision)} ${truncate(r.tool, 18).padEnd(18)} ` +
        `${truncate(r.input_summary, 56).padEnd(56)}  ${c.dim(`[${r.rule_id}]`)}${resolutionTag(r)}`,
    );
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
function guardsReport(db: SqlDb, asJson: boolean): number {
  const report = auditGuards(db);

  if (asJson) {
    console.log(JSON.stringify(report, null, 2));
    return 0;
  }

  if (report.denials === 0) {
    console.log(c.dim("No guard denials recorded yet — nothing to audit."));
    return 0;
  }

  console.log(
    c.bold("reins · guard audit") +
      c.dim(`  ${report.denials} denial${report.denials === 1 ? "" : "s"} across ${report.sessions} session${report.sessions === 1 ? "" : "s"}`),
  );
  console.log("");

  for (const v of report.rules) {
    const bits: string[] = [`${v.fired} fired`];
    if (v.stale > 0) bits.push(c.yellow(`${v.stale} wouldn't fire under today's shipped rules`));
    if (v.workedAround > 0) {
      const fastest =
        v.fastestWorkaroundMs !== null ? `, fastest ${humanGap(v.fastestWorkaroundMs)}` : "";
      bits.push(c.red(`${v.workedAround} worked around${fastest}`));
    }
    console.log(`  ${c.bold(v.rule_id.padEnd(24))} ${bits.join(c.dim(" · "))}`);
    for (const s of v.samples.slice(0, 3)) {
      const mark = s.workaround ? c.red("↻") : s.firesShipped ? c.dim("·") : c.yellow("~");
      console.log(`      ${mark} ${c.dim(day(s.ts))} ${truncate(s.summary, 68)}`);
      if (s.workaround) {
        console.log(
          c.dim(`        ran anyway ${humanGap(s.workaround.gapMs)} later: `) +
            truncate(s.workaround.summary, 52),
        );
      }
    }
    if (v.samples.length > 3) console.log(c.dim(`      … and ${v.samples.length - 3} more`));
    console.log("");
  }

  // The two readings, spelled out — the numbers above are only useful if the
  // reader knows which lever each one points at.
  if (report.stale > 0) {
    console.log(
      c.yellow("~") +
        ` ${report.stale} of ${report.denials} denials came from rules that have since been fixed upstream.`,
    );
    if (report.policyBehind) {
      console.log(c.dim("  Your policy still produces them — run `reins policy upgrade`."));
    } else {
      console.log(c.dim("  Your policy has already moved on; these are history."));
    }
  }
  if (report.workedAround > 0) {
    console.log(
      c.red("↻") +
        ` ${report.workedAround} denial${report.workedAround === 1 ? "" : "s"} ${report.workedAround === 1 ? "was" : "were"} undone by a near-identical call that ran anyway.`,
    );
    console.log(
      c.dim("  Guards match form, not intent. Narrow the rule, or make it a `--hold` that actually parks."),
    );
  }
  if (report.stale === 0 && report.workedAround === 0) {
    console.log(c.green("✓") + " Every recorded denial still stands under today's rules, and none was worked around.");
  }
  // Said plainly rather than left as a footnote: these verdicts are computed
  // from what capture stored, which collapsed whitespace and cut long commands.
  const truncated = report.rules.reduce((n, v) => n + v.samples.filter((s) => s.truncated).length, 0);
  if (truncated > 0) {
    console.log(
      c.dim(`  (${truncated} command${truncated === 1 ? " was" : "s were"} truncated at capture — those verdicts read a prefix, not the whole command.)`),
    );
  }
  return 0;
}

function day(ts: string): string {
  const d = new Date(ts);
  return isFinite(d.getTime()) ? d.toISOString().slice(0, 10) : ts;
}

function glyph(decision: string): string {
  switch (decision) {
    case "deny":
      return c.red("⛔");
    case "ask":
      return c.yellow("✋");
    case "hold":
      return c.cyan("⏳");
    case "allow":
      return c.green("✓");
    default:
      return "•";
  }
}

function resolutionTag(r: DecisionListRow): string {
  if (!r.resolution) return r.decision === "hold" ? c.dim("  (awaiting decision)") : "";
  const word = r.resolution === "approved" ? c.green("approved") : c.red("denied");
  return c.dim("  → ") + word + c.dim(` by ${r.resolver ?? "?"}`);
}

function time(ts: string): string {
  const d = new Date(ts);
  return isFinite(d.getTime()) ? d.toISOString().slice(11, 19) : ts;
}
