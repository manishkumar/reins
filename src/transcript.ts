import * as fs from "node:fs";

export interface TranscriptTotals {
  totalTokens: number | null;
  totalCost: number | null;
}

/**
 * Best-effort token/cost extraction from a session transcript (JSONL).
 *
 * The hook payload does not carry per-call cost cleanly, so we read the
 * transcript Claude Code references via transcript_path. Format varies across
 * versions, so this is intentionally defensive: any failure yields nulls (a
 * null column is harmless), never an exception that could disrupt the Stop hook.
 */
export function readTranscriptTotals(transcriptPath?: string): TranscriptTotals {
  const none: TranscriptTotals = { totalTokens: null, totalCost: null };
  if (!transcriptPath) return none;
  let text: string;
  try {
    text = fs.readFileSync(transcriptPath, "utf8");
  } catch {
    return none;
  }

  let tokens = 0;
  let sawTokens = false;
  let cost = 0;
  let sawCost = false;

  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }

    // Cost, if the transcript records it per-line.
    const costVal = numericField(obj, "costUSD") ?? numericField(obj, "cost");
    if (costVal !== null) {
      cost += costVal;
      sawCost = true;
    }

    // Usage block lives on assistant messages.
    const message = obj.message as Record<string, unknown> | undefined;
    const usage =
      (message?.usage as Record<string, unknown> | undefined) ??
      (obj.usage as Record<string, unknown> | undefined);
    if (usage) {
      const u = sumUsage(usage);
      if (u !== null) {
        tokens += u;
        sawTokens = true;
      }
    }
  }

  return {
    totalTokens: sawTokens ? tokens : null,
    totalCost: sawCost ? Math.round(cost * 1e6) / 1e6 : null,
  };
}

function numericField(obj: Record<string, unknown>, key: string): number | null {
  const v = obj[key];
  return typeof v === "number" && isFinite(v) ? v : null;
}

function sumUsage(usage: Record<string, unknown>): number | null {
  const keys = [
    "input_tokens",
    "output_tokens",
    "cache_creation_input_tokens",
    "cache_read_input_tokens",
  ];
  let total = 0;
  let saw = false;
  for (const k of keys) {
    const v = usage[k];
    if (typeof v === "number" && isFinite(v)) {
      total += v;
      saw = true;
    }
  }
  return saw ? total : null;
}
