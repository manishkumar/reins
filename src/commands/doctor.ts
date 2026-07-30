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
  const wiredAnywhere =
    checkSettings(path.join(process.cwd(), ".claude", "settings.json"), "settings.json", line) ||
    checkSettings(path.join(process.cwd(), ".claude", "settings.local.json"), "settings.local.json", line);
  if (!wiredAnywhere) {
    problems++;
    line(WARN, "hooks", "not wired — run `reins init` (or `reins init --print`)");
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
): boolean {
  if (!fs.existsSync(file)) return false;
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
  } catch {
    line(BAD, label, "exists but is not valid JSON");
    return false;
  }
  const hooks = (parsed.hooks ?? {}) as Record<string, Array<{ hooks?: Array<{ command?: string }> }>>;
  const events = ["PreToolUse", "PostToolUse", "Stop"];
  const wired = events.filter((ev) =>
    (hooks[ev] ?? []).some((e) => (e.hooks ?? []).some((h) => (h.command ?? "").includes("reins hook"))),
  );
  if (wired.length === 0) return false;
  const sym = wired.length === events.length ? OK : WARN;
  line(sym, label, `${wired.join(", ")} wired`);
  return wired.length === events.length;
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
