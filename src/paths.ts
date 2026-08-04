import * as path from "node:path";
import * as fs from "node:fs";

/**
 * Resolve the project root reins should operate in.
 *
 * The event `cwd` Claude Code sends is the working directory of the TOOL CALL,
 * not the project root — the Bash tool keeps a persistent shell cwd, so one
 * `cd packages/api` and every later event carries the subdirectory. Taking it
 * verbatim meant the hooks looked for `.reins/` there, found none, and treated
 * a configured project as an uninitialized one: the user's own rules silently
 * stopped applying (the built-in defaults still shipped, so nothing looked
 * broken), steering wasn't delivered at that boundary, filed approvals weren't
 * seen, and capture created a second .reins/ in the subdirectory. Silent,
 * because "no .reins" is indistinguishable from "not set up" by design.
 *
 * So the payload cwd is a starting point to walk up from, exactly as the
 * shell's cwd already was for user-facing commands.
 */
export function resolveProjectDir(payloadCwd?: string): string {
  const projectDir = process.env.CLAUDE_PROJECT_DIR?.trim() || "";
  if (payloadCwd && payloadCwd.trim()) {
    // Bounded by the session root when Claude Code tells us one. Without a
    // bound, a project that was never `reins init`-ed would climb PAST itself
    // into any ancestor that happens to have a .reins (a stray ~/.reins from
    // an experiment) and start writing state there — trading a bug that loses
    // your rules for one that files them somewhere you'll never look.
    return findProjectDir(payloadCwd, projectDir || undefined);
  }
  if (projectDir) return projectDir;
  // User-facing commands: find the project by walking up to an existing .reins,
  // so `reins steer` works from any subdirectory instead of silently writing a
  // stray .reins/ that the agent (rooted at the project dir) never reads.
  return findProjectDir(process.cwd());
}

/**
 * Walk up from `start` to the first ancestor containing a `.reins/` directory.
 * Falls back to `start` if none is found (e.g. a not-yet-initialized project).
 *
 * `stopAt`, when given, is the highest directory the walk may consider — it
 * is checked, and nothing above it is. A `stopAt` that isn't an ancestor of
 * `start` is ignored rather than obeyed, since a bound that doesn't contain
 * the starting point can't describe the same project.
 *
 * Runs in the hook path on every tool call, so it never throws: an unreadable
 * directory mid-walk falls back to `start` rather than taking down the host
 * run (a hook must always fail open).
 */
export function findProjectDir(start: string, stopAt?: string): string {
  const from = path.resolve(start);
  try {
    const bound = stopAt ? path.resolve(stopAt) : undefined;
    const bounded = bound !== undefined && isWithin(bound, from);
    let dir = from;
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (fs.existsSync(path.join(dir, ".reins"))) return dir;
      if (bounded && dir === bound) return from; // checked the bound; go no higher
      const parent = path.dirname(dir);
      if (parent === dir) return from; // reached filesystem root
      dir = parent;
    }
  } catch {
    return from;
  }
}

/** Is `child` the same directory as `parent`, or inside it? */
function isWithin(parent: string, child: string): boolean {
  if (child === parent) return true;
  const rel = path.relative(parent, child);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
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

/** Policy file v1: guards.json evolved into policy.json (superset schema —
 *  `expires`, `tool` rules). Canonical target for all writes. `guardsPath`
 *  above is kept around forever as the pre-0.3 fallback read path — see
 *  `loadGuards` in guards.ts. */
export function policyPath(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "policy.json");
}

export function configPath(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "config.json");
}

export function dbPath(payloadCwd?: string): string {
  return path.join(reinsDir(payloadCwd), "runs.db");
}
