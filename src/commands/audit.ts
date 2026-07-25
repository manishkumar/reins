import { openDbReadOnly, matchSessions, listDecisions, DecisionListRow } from "../db";
import { capabilityNote } from "../store";
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
  const positional = args.filter((a) => a !== "--json");

  const db = openDbReadOnly();
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
