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
  return process.cwd();
}

/** Absolute path to the project's .reins directory (not guaranteed to exist). */
export function reinsDir(payloadCwd?: string): string {
  return path.join(resolveProjectDir(payloadCwd), ".reins");
}

/** Ensure .reins exists and is self-gitignored, then return its path. */
export function ensureReinsDir(payloadCwd?: string): string {
  const dir = reinsDir(payloadCwd);
  fs.mkdirSync(dir, { recursive: true });
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
