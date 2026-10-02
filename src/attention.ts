import type { SqlDb } from "./store";
import { listDecisions } from "./db";
import { listPending, type PendingAction } from "./holds";
import { readLedger } from "./bypass";

/**
 * What a human has to act on, in one place: parked holds, hold breaches, and
 * denials that were worked around. `reins report` leads with it and
 * `reins watch` puts it in its top pane. Read-only, and never on the hook path.
 */

/** A parked action still waiting on a human (`.reins/pending/`). */
export interface AttentionHold {
  id: string;
  sessionId: string;
  tool: string;
  /** The proposed input, rendered for reading: the command, the path, or JSON. */
  input: string;
  ruleId: string;
  reason: string;
  ts: string;
}

/** A hold that executed while parked, or a denial worked around anyway. */
export interface AttentionEvent {
  kind: "breach" | "bypass";
  sessionId: string;
  ts: string;
  tool: string;
  summary: string;
  ruleId: string;
  detail: string;
}

/**
 * What a human has to act on, gathered first so the page can lead with it.
 * Holds come from plain files and are always present; breaches and bypasses
 * come from the decisions table when capture is available, and from the
 * bypass ledger otherwise (which only holds sessions not yet summarized).
 */
export interface Attention {
  holds: AttentionHold[];
  /** Breaches and bypasses inside EVENT_WINDOW_MS of generation. */
  events: AttentionEvent[];
  /** Ones older than that: counted, not listed. */
  olderEvents: number;
}

/**
 * A parked hold is listed at any age because it is still waiting. A breach or
 * bypass is a past event with no acknowledgement, so it stays at the top for a
 * week and then moves to a count; `reins audit --guards` keeps the full record.
 */
export const EVENT_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function collectAttention(
  repo: string,
  db: SqlDb | null,
  now: Date = new Date(),
): Attention {
  const holds: AttentionHold[] = listPending(repo).map((p) => ({
    id: p.id,
    sessionId: p.session_id,
    tool: p.tool,
    input: describeInput(p),
    ruleId: p.rule_id,
    reason: p.reason,
    ts: p.ts,
  }));

  const events: AttentionEvent[] = [];
  if (db) {
    try {
      for (const d of listDecisions(db, { limit: 100_000 })) {
        if (d.decision !== "breach" && d.decision !== "bypass") continue;
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
    } catch {
      /* an older runs.db without the decisions table: nothing to add */
    }
  } else {
    for (const r of readLedger(repo)) {
      if (!r.bypassed_ts) continue;
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
  const cutoff = now.getTime() - EVENT_WINDOW_MS;
  const recent = events.filter((e) => !(Date.parse(e.ts) < cutoff));
  // Breaches first (a hold that didn't hold), then newest first.
  recent.sort((a, b) => (a.kind !== b.kind ? (a.kind === "breach" ? -1 : 1) : a.ts < b.ts ? 1 : -1));
  return { holds, events: recent, olderEvents: events.length - recent.length };
}

/** What the approver is signing off on, in the form they'd recognize it. */
export function describeInput(p: PendingAction): string {
  const i = p.input as Record<string, unknown> | null;
  if (i && typeof i === "object") {
    if (typeof i.command === "string") return i.command;
    if (typeof i.file_path === "string") return i.file_path;
  }
  try {
    return JSON.stringify(p.input, null, 2) ?? "";
  } catch {
    return String(p.input);
  }
}

