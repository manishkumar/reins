import * as fs from "node:fs";
import { steeringPath, ensureReinsDir } from "./paths";

/** Queue a steering message for the next tool boundary. Latest write wins. */
export function writeSteering(message: string, payloadCwd?: string): void {
  ensureReinsDir(payloadCwd);
  fs.writeFileSync(steeringPath(payloadCwd), message.trim() + "\n");
}

/** Return the pending steering message without consuming it (for `reins steer`). */
export function peekSteering(payloadCwd?: string): string | null {
  try {
    const s = fs.readFileSync(steeringPath(payloadCwd), "utf8").trim();
    return s ? s : null;
  } catch {
    return null;
  }
}

export function clearSteering(payloadCwd?: string): void {
  try {
    fs.rmSync(steeringPath(payloadCwd));
  } catch {
    /* nothing to clear */
  }
}

/**
 * Atomically read AND clear the pending steering message (one-shot delivery).
 * Returns null if nothing is queued. Renaming first means a concurrent `steer`
 * write can't be silently dropped between read and delete.
 */
export function consumeSteering(payloadCwd?: string): string | null {
  const p = steeringPath(payloadCwd);
  const tmp = p + ".consuming." + process.pid;
  try {
    fs.renameSync(p, tmp);
  } catch {
    return null; // no pending steering
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
