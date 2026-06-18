import * as fs from "node:fs";
import { guardsPath, ensureReinsDir } from "./paths";

export type GuardType = "bash" | "path";

export interface GuardRule {
  id: string;
  type: GuardType;
  /** For "bash": a regex tested against the command string.
   *  For "path": a glob tested against file paths in the tool input. */
  pattern: string;
  reason: string;
}

export interface GuardsFile {
  rules: GuardRule[];
}

// A small, sane default denylist. Hard vetoes only — things almost no run
// legitimately needs and that are expensive/irreversible when wrong.
// Fully overridable: `reins guard remove <id>` or edit .reins/guards.json.
export const DEFAULT_RULES: GuardRule[] = [
  {
    id: "rm-rf",
    type: "bash",
    pattern: "\\brm\\s+(-[a-zA-Z]*\\s+)*-?[a-zA-Z]*r[a-zA-Z]*f|\\brm\\s+-rf?\\b|\\brm\\s+-fr?\\b",
    reason: "Recursive force-delete (rm -rf) is blocked by a reins guard.",
  },
  {
    id: "git-force-push",
    type: "bash",
    pattern: "git\\s+push\\b.*(--force\\b|--force-with-lease\\b|-f\\b)",
    reason: "Force-pushing is blocked by a reins guard (history rewrite).",
  },
  {
    id: "git-hard-reset",
    type: "bash",
    pattern: "git\\s+reset\\s+--hard\\b",
    reason: "git reset --hard is blocked by a reins guard (discards work).",
  },
  {
    id: "sql-drop",
    type: "bash",
    pattern: "\\b(DROP\\s+(TABLE|DATABASE|SCHEMA)|TRUNCATE\\s+TABLE)\\b",
    reason: "Destructive SQL (DROP/TRUNCATE) is blocked by a reins guard.",
  },
  {
    id: "curl-pipe-shell",
    type: "bash",
    pattern: "(curl|wget)\\b[^|]*\\|\\s*(sudo\\s+)?(sh|bash|zsh)\\b",
    reason: "Piping a downloaded script straight into a shell is blocked by a reins guard.",
  },
  {
    id: "write-dotenv",
    type: "path",
    pattern: "**/.env",
    reason: "Writing to .env is blocked by a reins guard (secrets).",
  },
  {
    // Close the obvious bypass of write-dotenv: a shell redirect/copy into .env.
    // Pattern guards are speed bumps, not a sandbox — see README limitations.
    id: "write-dotenv-bash",
    type: "bash",
    pattern: "(>>?|\\btee\\b|\\bcp\\b|\\bmv\\b)\\s*[^|;&]*\\.env(\\s|$|\"|')",
    reason: "Writing to .env via the shell is blocked by a reins guard (secrets).",
  },
  {
    id: "touch-git-internals",
    type: "path",
    pattern: "**/.git/**",
    reason: "Modifying .git internals is blocked by a reins guard.",
  },
];

export function loadGuards(payloadCwd?: string): GuardsFile {
  try {
    const raw = fs.readFileSync(guardsPath(payloadCwd), "utf8");
    const parsed = JSON.parse(raw) as GuardsFile;
    if (!Array.isArray(parsed.rules)) return { rules: [...DEFAULT_RULES] };
    return parsed;
  } catch {
    // No file yet => ship the defaults so guards work out of the box.
    return { rules: [...DEFAULT_RULES] };
  }
}

export function saveGuards(guards: GuardsFile, payloadCwd?: string): void {
  ensureReinsDir(payloadCwd);
  fs.writeFileSync(guardsPath(payloadCwd), JSON.stringify(guards, null, 2) + "\n");
}

/** Translate a minimal glob (`*`, `**`, `?`) into an anchored RegExp. */
export function globToRegExp(glob: string): RegExp {
  let re = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        re += ".*"; // ** matches across path separators
        i++;
        if (glob[i + 1] === "/") i++; // collapse **/ so it can match zero dirs
      } else {
        re += "[^/]*";
      }
    } else if (c === "?") {
      re += "[^/]";
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp("^" + re + "$");
}

/** Collect file-path-like fields from a tool input. */
function pathsFromInput(input: Record<string, unknown>): string[] {
  const keys = ["file_path", "path", "notebook_path"];
  const out: string[] = [];
  for (const k of keys) {
    if (typeof input[k] === "string") out.push(input[k] as string);
  }
  return out;
}

export interface GuardMatch {
  rule: GuardRule;
}

/** Returns the first matching guard rule for a tool call, or null. */
export function checkGuards(
  guards: GuardsFile,
  toolName: string,
  toolInput: unknown,
): GuardMatch | null {
  const input = (toolInput ?? {}) as Record<string, unknown>;
  for (const rule of guards.rules) {
    if (rule.type === "bash") {
      if (toolName !== "Bash") continue;
      const command = typeof input.command === "string" ? input.command : "";
      if (!command) continue;
      let re: RegExp;
      try {
        re = new RegExp(rule.pattern, "i");
      } catch {
        continue; // skip malformed user regex rather than crash the guard
      }
      if (re.test(command)) return { rule };
    } else if (rule.type === "path") {
      const paths = pathsFromInput(input);
      if (paths.length === 0) continue;
      let re: RegExp;
      try {
        re = globToRegExp(rule.pattern);
      } catch {
        continue;
      }
      for (const p of paths) {
        // Match against both the raw path and its basename-bearing form so a
        // glob like **/.env catches absolute, relative, and bare paths.
        if (re.test(p) || re.test("/" + p)) return { rule };
      }
    }
  }
  return null;
}
