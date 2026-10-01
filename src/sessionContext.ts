import * as fs from "node:fs";

/**
 * What a session is about, read from its Claude Code transcript.
 *
 * A mnemonic (`brave-otter`) tells sessions apart but says nothing about what
 * each one is doing. Claude Code already writes that down: the title it shows
 * in its own session list, the prompt the human last sent, and the git branch.
 * This reads those three from the tail of the transcript.
 *
 * Display only. Nothing here is reachable from `reins hook *`, and nothing it
 * returns feeds a guard, steer or hold decision. The transcript format is not
 * a documented interface, so every field is optional and any failure yields
 * nulls; callers fall back to the mnemonic.
 */

export interface SessionContext {
  /** The session's title: one set with /rename, else Claude Code's generated one. */
  title: string | null;
  /** The most recent prompt the human sent. */
  asked: string | null;
  branch: string | null;
}

export const NO_CONTEXT: SessionContext = { title: null, asked: null, branch: null };

/** Title, prompt and branch lines repeat every turn, so the tail is enough. */
const TAIL_BYTES = 256 * 1024;
/** Metadata lines are short. Longer lines are messages and are never parsed. */
const MAX_META_LINE = 64 * 1024;
const BRANCH_RE = /"gitBranch":"((?:[^"\\]|\\.)*)"/;

const cache = new Map<string, { mtimeMs: number; size: number; ctx: SessionContext }>();

export function readSessionContext(transcriptPath?: string | null): SessionContext {
  if (!transcriptPath || !transcriptPath.endsWith(".jsonl")) return NO_CONTEXT;
  try {
    const stat = fs.statSync(transcriptPath);
    if (!stat.isFile()) return NO_CONTEXT;
    const hit = cache.get(transcriptPath);
    if (hit && hit.mtimeMs === stat.mtimeMs && hit.size === stat.size) return hit.ctx;
    const ctx = parseTail(readTail(transcriptPath, stat.size));
    cache.set(transcriptPath, { mtimeMs: stat.mtimeMs, size: stat.size, ctx });
    return ctx;
  } catch {
    return NO_CONTEXT;
  }
}

function readTail(file: string, size: number): string {
  const len = Math.min(size, TAIL_BYTES);
  const buf = Buffer.alloc(len);
  const fd = fs.openSync(file, "r");
  try {
    fs.readSync(fd, buf, 0, len, size - len);
  } finally {
    fs.closeSync(fd);
  }
  const text = buf.toString("utf8");
  // A tail that starts mid-file starts mid-line; drop the partial one.
  return len < size ? text.slice(text.indexOf("\n") + 1) : text;
}

/** Exported for tests. Later lines win, so the newest title and prompt are kept. */
export function parseTail(text: string): SessionContext {
  let custom: string | null = null;
  let ai: string | null = null;
  let asked: string | null = null;
  let branch: string | null = null;

  for (const line of text.split("\n")) {
    if (!line) continue;
    const b = BRANCH_RE.exec(line);
    if (b) branch = unescape(b[1]) ?? branch;

    if (line.length > MAX_META_LINE) continue;
    if (!line.includes('"custom-title"') && !line.includes('"ai-title"') && !line.includes('"last-prompt"')) continue;
    let obj: Record<string, unknown>;
    try {
      obj = JSON.parse(line);
    } catch {
      continue;
    }
    // Checked on the parsed top level, so a tool result that quotes one of
    // these lines is not mistaken for one.
    if (obj.type === "custom-title") custom = text1(obj.customTitle) ?? custom;
    else if (obj.type === "ai-title") ai = text1(obj.aiTitle) ?? ai;
    else if (obj.type === "last-prompt") asked = text1(obj.lastPrompt) ?? asked;
  }
  return { title: custom ?? ai, asked, branch };
}

function text1(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.replace(/\s+/g, " ").trim();
  return t || null;
}

function unescape(raw: string): string | null {
  try {
    return text1(JSON.parse(`"${raw}"`));
  } catch {
    return null;
  }
}
