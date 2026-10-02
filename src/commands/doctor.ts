import { SETTINGS_BLOCK } from "../settingsBlock";
import { claudeSightings, claudeCodeVersion, predatesFailureHook, FAILURE_HOOK, FAILURE_HOOK_SINCE } from "../claudeVersion";
import { readHooksSeen } from "../heartbeat";
import * as fs from "node:fs";
import * as path from "node:path";
import { reinsDir, steeringPath } from "../paths";
import { getDriver, capabilityNote } from "../store";
import { loadGuards, validateRules, policySource } from "../guards";
import { planUpgrade, stalenessNote } from "../policyUpgrade";
import { loadConfig } from "../config";
import { peekSteering } from "../steering";
import { listPending } from "../holds";
import { c } from "./format";

const OK = c.green("✓");
const WARN = c.yellow("!");
const BAD = c.red("✗");

/** Diagnose a reins setup. The first thing to run when something seems off. */
export function cmdDoctor(): number {
  let problems = 0;
  // Things worth showing that are not faults: an expired rule doing exactly
  // what it was told to, a broad pattern, holds waiting for you. They print a
  // "!" like problems do, so the summary counts them separately rather than
  // showing a "!" line the total silently ignores.
  let notes = 0;
  const line = (sym: string, label: string, detail: string) =>
    console.log(`  ${sym} ${label.padEnd(22)} ${c.dim(detail)}`);

  console.log(c.bold("reins doctor") + c.dim("  (cwd: " + process.cwd() + ")"));
  console.log("");

  // Runtime
  console.log(c.bold("Runtime"));
  line(OK, "reins version", reinsVersion());
  const driver = getDriver();
  if (driver) {
    line(OK, "node", process.version + ` — capture via ${driver.name}`);
  } else {
    problems++;
    line(WARN, "node", process.version);
    line(WARN, "capture", capabilityNote());
  }

  // Project state
  console.log("");
  console.log(c.bold("Project (.reins)"));
  const dir = reinsDir();
  if (fs.existsSync(dir)) {
    line(OK, ".reins dir", dir);
    if (isWritable(dir)) line(OK, "writable", "yes");
    else {
      problems++;
      line(BAD, "writable", "NO — guards/steering/capture cannot persist state");
    }
    line(OK, "loop threshold", String(loadConfig().loopThreshold));
    const pending = peekSteering();
    if (pending) notes++;
    line(pending ? WARN : OK, "pending steering", pending ? `"${pending}"` : "none");
    const holds = listPending().length;
    if (holds > 0) notes++;
    line(
      holds > 0 ? WARN : OK,
      "pending holds",
      holds > 0 ? `${holds} awaiting approval — reins pending` : "none",
    );
    // Strays left by the pre-0.4.1 resolution bug (hooks took the tool call's
    // cwd verbatim, so a `cd` into a subdirectory created a second .reins
    // there). Fixing the resolution doesn't heal them: from inside that
    // subdirectory the stray is still the NEAREST ancestor, so it keeps
    // winning. Report, never delete — one of these can legitimately be a
    // nested project, and dropping someone's runs.db is not doctor's job.
    const strays = findNestedReinsDirs(path.dirname(dir));
    if (strays.length > 0) {
      problems++;
      line(WARN, "stray .reins dirs", `${strays.length} below the project root — see below`);
      for (const s of strays) line(WARN, "  ", s);
      line(
        WARN,
        "  ",
        "each shadows your policy for tool calls made from inside it; remove if not a nested project",
      );
    }
  } else {
    problems++;
    line(WARN, ".reins dir", "not initialized — run `reins init`");
  }

  // Policy (guards)
  console.log("");
  console.log(c.bold("Policy"));
  const source = policySource();
  const sourceLabel =
    source === "defaults" ? "built-in defaults (no policy.json or guards.json)" : `.reins/${source}`;
  line(OK, "source", sourceLabel);
  const guards = loadGuards();
  line(OK, "rule count", `${guards.rules.length}`);
  // Staleness. Before this check existed, a rule fix could ship upstream and
  // never reach a single existing install — which is exactly what happened to
  // the recursive-rm pattern between June and July 2026.
  const plan = planUpgrade(guards);
  const stale = stalenessNote(plan);
  if (stale) {
    notes++;
    line(WARN, "policy version", stale);
  } else {
    line(OK, "policy version", `v${plan.toVersion} (current)`);
  }
  const policyProblems = validateRules(guards.rules);
  const errors = policyProblems.filter((p) => p.severity === "error");
  const warnings = policyProblems.filter((p) => p.severity === "warning");
  if (policyProblems.length === 0) {
    line(OK, "rules", "no problems found");
  } else {
    for (const p of errors) {
      problems++;
      line(BAD, `rule ${p.ruleId}`, p.message);
    }
    for (const p of warnings) {
      notes++;
      line(WARN, `rule ${p.ruleId}`, p.message);
    }
  }

  // Hook wiring
  console.log("");
  console.log(c.bold("Hook wiring (.claude)"));
  const seen = readHooksSeen(reinsDir());
  const sightings = claudeSightings(seen?.claude);
  const claude = claudeCodeVersion(seen?.claude);
  const old = predatesFailureHook(claude);
  const unknown = claude === null;
  if (unknown) {
    notes++;
    line(WARN, "Claude Code", `version unknown (claude is not on PATH and no hook has reported one). A version older than ${FAILURE_HOOK_SINCE} loads no hooks from a file that names ${FAILURE_HOOK}`);
  } else {
    const where = sightings.map((s) => `${s.version} from ${s.from}`).join(", ");
    line(OK, "Claude Code", old ? `${where}. Older than ${FAILURE_HOOK_SINCE}: no ${FAILURE_HOOK} event, so failed tool calls are not captured` : where);
  }
  const settingsFiles = [
    path.join(process.cwd(), ".claude", "settings.json"),
    path.join(process.cwd(), ".claude", "settings.local.json"),
  ];
  const wiring = [
    checkSettings(settingsFiles[0], "settings.json", line, old, unknown),
    checkSettings(settingsFiles[1], "settings.local.json", line, old, unknown),
  ];
  // The fact behind every version check above: has a hook run since the file changed?
  if (wiring.some((w) => w !== "none")) {
    const changed = Math.max(...settingsFiles.map((f) => (fs.existsSync(f) ? fs.statSync(f).mtimeMs : 0)));
    const ran = Object.entries(seen?.events ?? {}).filter(([, ts]) => Date.parse(ts) > changed).map(([ev]) => ev);
    if (ran.length > 0) {
      line(OK, "seen running", `${ran.sort().join(", ")} ran after the settings file last changed, so Claude Code loads it`);
    } else {
      const named = settingsFiles.some((f) => namesFailureHook(f));
      const how = "make one tool call in a Claude Code session here, then run reins doctor again";
      if (unknown && named) {
        problems++;
        line(BAD, "seen running", `no hook has run since the settings file last changed, it names ${FAILURE_HOOK}, and the Claude Code version is unknown. Until one runs, assume no guard is active: ${how}`);
      } else {
        notes++;
        line(WARN, "seen running", `no hook has run since the settings file last changed: ${how}`);
      }
    }
  }
  if (wiring.includes("dead")) {
    problems++;
    line(BAD, "hooks", `this Claude Code loads NO hooks from a file that names ${FAILURE_HOOK}: no guard, hold or steer runs. Run \`reins init\` to take it out, or upgrade Claude Code`);
  } else if (!wiring.includes("full")) {
    problems++;
    line(
      WARN,
      "hooks",
      wiring.includes("partial")
        ? "partly wired — run `reins init` to add the missing ones (it merges, and keeps what is there)"
        : "not wired — run `reins init` (or `reins init --print`)",
    );
  }

  // PATH
  console.log("");
  console.log(c.bold("Install"));
  line(OK, "invoked as", process.argv[1] || "?");
  line(OK, "note", "hooks call bare `reins` — it must be on PATH for every shell Claude Code spawns");

  console.log("");
  const noteSuffix = notes > 0 ? c.dim(` (${notes} note${notes === 1 ? "" : "s"} above)`) : "";
  if (problems === 0) {
    console.log(OK + c.green(" Everything looks good.") + noteSuffix);
  } else {
    console.log(
      WARN +
        c.yellow(` ${problems} thing${problems === 1 ? "" : "s"} to look at above.`) +
        noteSuffix,
    );
  }
  return problems === 0 ? 0 : 1;
}

function checkSettings(
  file: string,
  label: string,
  line: (sym: string, label: string, detail: string) => void,
  old: boolean,
  /** Version unknown: `reins init` leaves the failure hook out on purpose, so its absence is not "partly wired". */
  unknown = false,
): "full" | "partial" | "none" | "dead" {
  if (!fs.existsSync(file)) return "none";
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  } catch {
    line(BAD, label, "exists but is not valid JSON");
    return "none";
  }
  const hooks = (parsed.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  // An event this Claude Code does not know, from reins or anyone else.
  if (old && FAILURE_HOOK in hooks) {
    line(BAD, label, `names ${FAILURE_HOOK}, which this Claude Code does not know`);
    return "dead";
  }
  const optional = (ev: string) => ev === FAILURE_HOOK && (old || (unknown && !(FAILURE_HOOK in hooks)));
  const events = Object.keys(SETTINGS_BLOCK.hooks).filter((ev) => !optional(ev));
  const wired = events.filter((ev) =>
    (hooks[ev] ?? []).some((e) => (e.hooks ?? []).some((h) => (h.command ?? "").includes("reins hook"))),
  );
  if (wired.length === 0) return "none";
  const missing = events.filter((ev) => !wired.includes(ev));
  if (missing.length === 0) {
    line(OK, label, `${wired.join(", ")} wired`);
    return "full";
  }
  // An install from before a hook existed. The usual one is PostToolUseFailure:
  // without it, failed commands are not captured and never trip the loop alarm.
  line(WARN, label, `${wired.join(", ")} wired; missing ${missing.join(", ")}`);
  return "partial";
}

function namesFailureHook(file: string): boolean {
  try {
    const hooks = JSON.parse(fs.readFileSync(file, "utf8") || "{}").hooks;
    return !!hooks && typeof hooks === "object" && FAILURE_HOOK in hooks;
  } catch {
    return false;
  }
}

/**
 * Find `.reins/` directories nested below the project root.
 *
 * Deliberately shallow and cheap — doctor runs interactively, and a stray from
 * an agent's `cd` lands in a working directory, not twelve levels into a
 * dependency tree. Skips the usual unwalkable/uninteresting places, and never
 * throws: a diagnostic that dies on one unreadable directory is worse than one
 * that reports what it could read.
 */
function findNestedReinsDirs(root: string, maxDepth = 4): string[] {
  const SKIP = new Set([".git", ".reins", "node_modules", "dist", "build", "out", "coverage", ".next"]);
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name)) continue;
      const child = path.join(dir, e.name);
      if (fs.existsSync(path.join(child, ".reins"))) found.push(path.join(child, ".reins"));
      walk(child, depth + 1);
    }
  };
  walk(root, 1);
  return found;
}

function reinsVersion(): string {
  try {
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

function isWritable(dir: string): boolean {
  try {
    const probe = path.join(dir, ".doctor-write-probe");
    fs.writeFileSync(probe, "");
    fs.rmSync(probe);
    return true;
  } catch {
    return false;
  }
}
