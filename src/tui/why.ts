import { dropHeredocData, firingSegment, splitCommandSegments, type GuardRule } from "../guards";

/**
 * Where in a held Bash command its rule matched, for the approver to read.
 *
 * A hold names its rule and reason, but on a long command (a script in a
 * heredoc) the text that tripped the rule can be ninety lines down. This finds
 * it with the guard's own matcher (`firingSegment`), so the cockpit shows the
 * segment the guard fired on and not a second opinion.
 *
 * Display only. The rule is read as it stands now; if it was edited or removed
 * since the action parked and no longer fires, there is nothing to show and
 * the answer is null.
 */

export interface MatchSpan {
  /** Offsets into the command text. */
  start: number;
  end: number;
  /** 1-based line of `start`, and the command's line count. */
  line: number;
  lines: number;
}

export function whyMatched(rule: GuardRule | undefined, command: string, cwd?: string): MatchSpan | null {
  if (!rule || rule.type !== "bash" || !command) return null;
  const seg = firingSegment(rule, command, cwd);
  if (seg === null) return null;

  // Segments are substrings of the command, in order. Read the same way the
  // guard reads it, with heredoc data left out.
  let at = 0;
  for (const s of splitCommandSegments(dropHeredocData(command))) {
    at = command.indexOf(s, at);
    if (at < 0) return null;
    if (s === seg) break;
    at += s.length;
  }

  // Narrow to the matched text. The guard matches with quoted text removed;
  // blanking it in place keeps the offsets. If that reads differently, the
  // whole segment is the answer.
  let start = at + (seg.length - seg.trimStart().length);
  let end = at + seg.trimEnd().length;
  try {
    const blank = (q: string) => " ".repeat(q.length);
    const m = new RegExp(rule.pattern, "i").exec(seg.replace(/"(?:[^"\\]|\\.)*"/g, blank).replace(/'[^']*'/g, blank));
    if (m && m[0].length) {
      start = at + m.index;
      end = start + m[0].length;
    }
  } catch {
    /* keep the segment */
  }
  return { start, end, line: command.slice(0, start).split("\n").length, lines: command.split("\n").length };
}
