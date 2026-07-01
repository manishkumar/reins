import * as fs from "node:fs";
import * as path from "node:path";
import { steeringPath, reinsDir, ensureReinsDir } from "./paths";

/**
 * Steering can be a broadcast (global) or targeted at one session. With several
 * agents in one repo, a global nudge lands on whichever session hits the next
 * tool boundary first; targeting one writes a per-session file the hook prefers.
 *
 *   global   -> .reins/steering.txt
 *   targeted -> .reins/steering.<sessionId>.txt
 */
export function steeringFileFor(payloadCwd: string | undefined, sessionId?: string): string {
  if (!sessionId) return steeringPath(payloadCwd);
  return path.join(reinsDir(payloadCwd), `steering.${sanitize(sessionId)}.txt`);
}

function sanitize(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "_");
}

/** Queue a steering message for the next tool boundary, replacing any pending. */
export function writeSteering(message: string, payloadCwd?: string, sessionId?: string): void {
  ensureReinsDir(payloadCwd);
  fs.writeFileSync(steeringFileFor(payloadCwd, sessionId), message.trim() + "\n");
}

/**
 * Append a nudge to any pending steering instead of clobbering it. Two quick
 * `reins steer` calls before the next tool boundary should both reach the
 * agent, not silently drop the first. Returns the number of nudges now queued.
 */
export function appendSteering(message: string, payloadCwd?: string, sessionId?: string): number {
  const existing = peekSteering(payloadCwd, sessionId);
  if (!existing) {
    writeSteering(message, payloadCwd, sessionId);
    return 1;
  }
  const combined = existing + "\n" + message.trim();
  fs.writeFileSync(steeringFileFor(payloadCwd, sessionId), combined + "\n");
  return combined.split("\n").filter((l) => l.trim()).length;
}

/** Return the pending steering message without consuming it (for `reins steer`). */
export function peekSteering(payloadCwd?: string, sessionId?: string): string | null {
  try {
    const s = fs.readFileSync(steeringFileFor(payloadCwd, sessionId), "utf8").trim();
    return s ? s : null;
  } catch {
    return null;
  }
}

export function clearSteering(payloadCwd?: string, sessionId?: string): void {
  try {
    fs.rmSync(steeringFileFor(payloadCwd, sessionId));
  } catch {
    /* nothing to clear */
  }
}

/** List all session ids that currently have targeted steering pending. */
export function pendingTargetedSessions(payloadCwd?: string): string[] {
  try {
    return fs
      .readdirSync(reinsDir(payloadCwd))
      .map((f) => /^steering\.(.+)\.txt$/.exec(f)?.[1])
      .filter((x): x is string => !!x);
  } catch {
    return [];
  }
}

/**
 * Atomically read AND clear the pending steering for this tool boundary.
 * A session-targeted nudge (matching this session_id) is preferred; otherwise
 * the global broadcast is consumed. Renaming first means a concurrent `steer`
 * write can't be silently dropped between read and delete.
 */
export function consumeSteering(payloadCwd?: string, sessionId?: string): string | null {
  if (sessionId) {
    const targeted = consumeFile(steeringFileFor(payloadCwd, sessionId));
    if (targeted) return targeted;
  }
  return consumeFile(steeringPath(payloadCwd));
}

function consumeFile(p: string): string | null {
  const tmp = p + ".consuming." + process.pid;
  try {
    fs.renameSync(p, tmp);
  } catch {
    return null; // not present
  }
  try {
    const s = fs.readFileSync(tmp, "utf8").trim();
    return s ? s : null;
  } finally {
    try {
      fs.rmSync(tmp);
    } catch {
      /* ignore */
    }
  }
}

/**
 * The exact text injected as PreToolUse additionalContext.
 *
 * Framing is load-bearing (verified in the build spike): the model weighs
 * hook-injected context against the user's original prompt and resists anything
 * that reads like a hijack ("STOP, ignore previous"). Steering is the detail
 * the same author forgot to put in the original prompt — additive spec that
 * composes with the goal, never an order that overrides it. Phrase it that way.
 */
export function formatSteeringContext(message: string): string {
  return (
    "[reins — live steering from the developer running this session]\n" +
    message +
    "\n\nTreat this as additional detail for the task in progress, from the same " +
    "person who wrote the original request — spec they want folded into the " +
    "current work. It refines the goal; it does not replace it."
  );
}

/**
 * The Stop-hook variant: steering that arrived after the agent's last tool
 * boundary is delivered by blocking the stop (this text is the block reason).
 * Same author-framing as above, plus explicit instruction on what "continue"
 * means here — address the note, then finish; don't restart the task.
 */
export function formatSteeringStopReason(message: string): string {
  return (
    "[reins — steering from the developer, delivered as you were finishing]\n" +
    message +
    "\n\nThis note was queued before you stopped and would otherwise have been " +
    "lost. It is additional detail from the same person who wrote the original " +
    "request. Address it — adjusting or extending the work you just did as " +
    "needed — and then finish. It refines the goal; it does not replace it."
  );
}
