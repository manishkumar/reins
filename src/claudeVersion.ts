import { execFileSync } from "node:child_process";
import { claudeVersionFromEnv, parseVersion } from "./heartbeat";

export { parseVersion };

/**
 * Which Claude Code is installed, for `reins init` and `reins doctor`.
 *
 * It matters because of one measured fact: Claude Code 2.0.55 and older load NO
 * hooks from a settings file that names an event they do not know. reins
 * writes `PostToolUseFailure`, which arrived in 2.0.56. On an older Claude
 * Code that one key turns off every guard, hold and steer in the file, with no
 * error. Measured by running 2.0.0, 2.0.55 and 2.0.56 against the same
 * settings file (docs/open-questions.md, item 3).
 *
 * Never called from `reins hook *`: a hook that is not loaded cannot check
 * anything, and one that is loaded has no need to.
 */

/** The first Claude Code that knows the `PostToolUseFailure` event. */
export const FAILURE_HOOK_SINCE = "2.0.56";
export const FAILURE_HOOK = "PostToolUseFailure";

export interface ClaudeSighting {
  version: string;
  /** Where it was read, in words a person can check. */
  from: string;
}

/**
 * Every place the Claude Code version can be read, because any one of them can
 * be missing: `claude` may not be on PATH (an IDE extension, a desktop app),
 * and `reins init` may be run from a plain terminal with no session around it.
 *   - `claude --version`;
 *   - the environment Claude Code gives the commands it runs, when init or
 *     doctor is run from inside a session;
 *   - the version a reins hook last saw in this project (`sawInHook`).
 */
export function claudeSightings(sawInHook?: string | null): ClaudeSighting[] {
  // Tests, and a person who knows better, can say it outright.
  const stated = process.env.REINS_CLAUDE_VERSION;
  if (stated !== undefined) {
    const v = parseVersion(stated);
    return v ? [{ version: v, from: "REINS_CLAUDE_VERSION" }] : [];
  }
  const out: ClaudeSighting[] = [];
  try {
    const v = parseVersion(execFileSync("claude", ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] }));
    if (v) out.push({ version: v, from: "claude --version" });
  } catch {
    /* not on PATH */
  }
  const here = claudeVersionFromEnv();
  if (here) out.push({ version: here, from: "this session" });
  if (sawInHook) out.push({ version: sawInHook, from: "the last hook run here" });
  return out;
}

/**
 * The version to act on: the OLDEST one seen, or null when none was. Two
 * installs can coexist (a current CLI on PATH, an old one in an editor), and
 * the settings file is read by both. Writing for the oldest is the direction
 * in which a guard cannot go quiet.
 */
export function claudeCodeVersion(sawInHook?: string | null): string | null {
  const seen = claudeSightings(sawInHook).map((s) => s.version);
  return seen.length ? seen.reduce((a, b) => (olderThan(b, a) ? b : a)) : null;
}

export function olderThan(version: string, than: string): boolean {
  const a = version.split(".").map(Number);
  const b = than.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) < (b[i] ?? 0);
  }
  return false;
}

/** True when the installed Claude Code is known to predate the failure hook. */
export function predatesFailureHook(version: string | null): boolean {
  return version !== null && olderThan(version, FAILURE_HOOK_SINCE);
}

/**
 * May `reins init` write the failure hook? Only on positive evidence that
 * every Claude Code seen knows it. An unknown version gets the three hooks
 * every version accepts: losing capture of failed calls is a smaller loss
 * than a file that turns every guard off. `reins init --failure-hook` is the
 * person saying they know their version.
 */
export function mayWriteFailureHook(version: string | null): boolean {
  return version !== null && !olderThan(version, FAILURE_HOOK_SINCE);
}
