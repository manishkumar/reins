import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Resolve the project root reins should operate in.
 *
 * For hook invocations, Claude Code provides the session cwd in the event
 * payload and also sets $CLAUDE_PROJECT_DIR. For user-facing commands we use
 * the shell's cwd. Explicit payload cwd wins so the .reins dir always tracks
 * the project the agent is actually running in.
 */
export function resolveProjectDir(payloadCwd?: string): string {
  if (payloadCwd && payloadCwd.trim()) return payloadCwd;
  if (process.env.CLAUDE_PROJECT_DIR && process.env.CLAUDE_PROJECT_DIR.trim()) {
    return process.env.CLAUDE_PROJECT_DIR;
  }
  // User-facing commands: find the project by walking up to an existing .reins,
  // so `reins steer` works from any subdirectory instead of silently writing a
  // stray .reins/ that the agent (rooted at the project dir) never reads.
  return findProjectDir(process.cwd());
}

/**
 * Walk up from `start` to the first ancestor containing a `.reins/` directory.
 * Falls back to `start` if none is found (e.g. a not-yet-initialized project).
 */
export function findProjectDir(start: string): string {
  let dir = path.resolve(start);
  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (fs.existsSync(path.join(dir, ".reins"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start); // reached filesystem root
    dir = parent;
  }
}

/** Absolute path to the project's .reins directory (not guaranteed to exist). */
export function reinsDir(payloadCwd?: string): string {
  return path.join(resolveProjectDir(payloadCwd), ".reins");
}

/** Ensure .reins exists and is self-gitignored, then return its path. */
export function ensureReinsDir(payloadCwd?: string): string {
  const dir = reinsDir(payloadCwd);
  // 0700: .reins holds steering (write access == steering access) and the
  // trajectory log. Owner-only by default is defense-in-depth for the threat
  // model. Mode is best-effort (ignored on Windows) and applies on creation.
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const gitignore = path.join(dir, ".gitignore");
  if (!fs.existsSync(gitignore)) {
    // The .reins dir holds local state (steering, db) that must never be
    // committed. Self-ignore so the user doesn't have to touch root .gitignore.
    fs.writeFileSync(gitignore, "# Created by reins. Local agent state — never commit.\n*\n");
  }
  return dir;
}

export function steeringPath(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "steering.txt");
}

export function guardsPath(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "guards.json");
}

export function configPath(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "config.json");
}

export function dbPath(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "runs.db");
}
