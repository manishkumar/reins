import type { SqlDb } from "./store";
import { hasSessionNameColumn, hasSessionTranscriptColumn } from "./db";
import { displayName } from "./names";
import { readSessionContext } from "./sessionContext";

/**
 * How a session is shown, on every surface: the cockpit, `sessions`,
 * `pending`, `lastrun`, the steer picker and the report all get it from
 * `sessionFace`, so a session never has two different names in two places.
 *
 * Display only, and never on the hook path. The strings are already free of
 * control characters (see sessionContext); callers still escape for their
 * own medium.
 */
export interface SessionFace {
  /** The name `reins steer` accepts: the custom one, else the mnemonic. */
  name: string;
  /** What a row leads with: the custom name, else the session's title, else the mnemonic. */
  label: string;
  /** The human's most recent prompt, from the transcript. */
  asked: string | null;
  branch: string | null;
}

export function sessionFace(id: string, custom?: string | null, transcript?: string | null): SessionFace {
  const ctx = readSessionContext(transcript);
  const name = displayName(id, custom);
  return { name, label: (custom ?? "").trim() || ctx.title || name, asked: ctx.asked, branch: ctx.branch };
}

/** Look sessions up by id, once each. Without a DB every session gets its mnemonic. */
export function faceReader(db: SqlDb | null): (id: string) => SessionFace {
  const seen = new Map<string, SessionFace>();
  let sql: string | null = null;
  return (id) => {
    let f = seen.get(id);
    if (f) return f;
    f = sessionFace(id);
    if (db) {
      try {
        sql ??= `SELECT ${hasSessionNameColumn(db) ? "name" : "NULL AS name"}, ${
          hasSessionTranscriptColumn(db) ? "transcript" : "NULL AS transcript"
        } FROM sessions WHERE id = ?`;
        const r = db.prepare(sql).get(id) as { name: string | null; transcript: string | null } | undefined;
        if (r) f = sessionFace(id, r.name, r.transcript);
      } catch {
        /* locked or older db: the mnemonic stands */
      }
    }
    seen.set(id, f);
    return f;
  };
}

export function shortId(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}

/** The name and short id a human types to address the session. */
export function addressOf(f: SessionFace, id: string): string {
  return `${f.name} ${shortId(id)}`;
}

/** What leads a row: the label, or the address when there is no title to lead with. */
export function headOf(f: SessionFace, id: string): string {
  return f.label === f.name ? addressOf(f, id) : f.label;
}

/** The line under the head: the address (when a title took the head), branch and last prompt. */
export function aboutOf(f: SessionFace, id: string, maxAsked = 70): string {
  const asked = f.asked && f.asked.length > maxAsked ? f.asked.slice(0, maxAsked - 1) + "…" : f.asked;
  return [f.label === f.name ? "" : addressOf(f, id), f.branch ? `⎇ ${f.branch}` : "", asked ? `❯ ${asked}` : ""]
    .filter(Boolean)
    .join(" · ");
}
