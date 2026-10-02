import * as fs from "node:fs";
import * as path from "node:path";
import { reinsDir } from "./paths";

/**
 * Proof that Claude Code loads the hooks: each hook notes that it ran.
 *
 * A settings file Claude Code refuses looks, from the outside, exactly like one
 * it accepts. An older Claude Code drops every hook in a file that names an
 * event it does not know and says nothing (src/claudeVersion.ts). Reading a
 * version number is a guess about that. A hook having run is the fact. `reins
 * doctor` compares the last run against the settings file's modification time
 * and says when no hook has run since the file changed.
 *
 * `.reins/hooks-seen.json`, a plain file: this must work without SQLite, and
 * nothing decides on it. No guard, hold or steer reads it. Written at most
 * once a minute per event, never created outside an initialized project, and
 * never for a call without a session id (a manual `reins hook` run is not
 * Claude Code loading anything). Every failure is swallowed: this is the hook
 * path, and a note that cannot be written must not touch the tool call.
 */

export interface HooksSeen {
  /** Event name to the ISO time a hook for it last ran. */
  events: Record<string, string>;
  /** The Claude Code version the hook found in its own environment, if any. */
  claude?: string;
}

// Kept here, not in claudeVersion.ts, so the hook path never loads child_process.
export function parseVersion(text: string): string | null {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
  return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}

const FILE = "hooks-seen.json";
const EVERY_MS = 60_000;

/** The version of the Claude Code that spawned this process, from the environment it sets. */
export function claudeVersionFromEnv(env: NodeJS.ProcessEnv = process.env): string | null {
  // AI_AGENT=claude-code_2-1-287_agent
  const agent = /^claude-code_(\d+)-(\d+)-(\d+)/.exec(env.AI_AGENT ?? "");
  if (agent) return `${Number(agent[1])}.${Number(agent[2])}.${Number(agent[3])}`;
  // CLAUDE_CODE_EXECPATH=…/claude/versions/2.1.287
  const exec = /[\\/]versions[\\/](\d+\.\d+\.\d+)(?:$|[\\/])/.exec(env.CLAUDE_CODE_EXECPATH ?? "");
  return exec ? parseVersion(exec[1]) : null;
}

export function readHooksSeen(dir: string): HooksSeen | null {
  try {
    const seen = JSON.parse(fs.readFileSync(path.join(dir, FILE), "utf8"));
    if (!seen || typeof seen.events !== "object" || seen.events === null) return null;
    return { events: seen.events, claude: typeof seen.claude === "string" ? (parseVersion(seen.claude) ?? undefined) : undefined };
  } catch {
    return null;
  }
}

export function markHookRan(event: string, sessionId: string, payloadCwd?: string, now: Date = new Date()): void {
  if (!sessionId) return;
  try {
    const dir = reinsDir(payloadCwd);
    if (!fs.existsSync(dir)) return;
    const seen = readHooksSeen(dir) ?? { events: {} };
    const claude = claudeVersionFromEnv() ?? undefined;
    const last = Date.parse(seen.events[event] ?? "");
    if (Number.isFinite(last) && now.getTime() - last < EVERY_MS && seen.claude === claude) return;
    seen.events[event] = now.toISOString();
    if (claude) seen.claude = claude;
    else delete seen.claude;
    const file = path.join(dir, FILE);
    const tmp = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(seen) + "\n", { mode: 0o600 });
    fs.renameSync(tmp, file);
  } catch {
    /* never the tool call's problem */
  }
}
