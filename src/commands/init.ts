import * as fs from "node:fs";
import * as path from "node:path";
import { ensureReinsDir, guardsPath, policyPath, configPath } from "../paths";
import { loadGuards, saveGuards, POLICY_VERSION } from "../guards";
import { seededDefaults } from "../policyUpgrade";
import { loadConfig, saveConfig } from "../config";
import { settingsBlockJson } from "../settingsBlock";
import { mergeReinsHooks } from "../settingsMerge";
import { getDriver, capabilityNote } from "../store";
import { installMod } from "../modInstall";
import { claudeCodeVersion, predatesFailureHook, FAILURE_HOOK, FAILURE_HOOK_SINCE } from "../claudeVersion";
import { c } from "./format";

export function cmdInit(args: string[]): number {
  const printOnly = args.includes("--print") || args.includes("-p");
  const useLocal = args.includes("--local");
  const withMod = args.includes("--mod");

  // init always targets the CURRENT directory (it's an explicit "set up here"),
  // never a parent project found by walk-up.
  const here = process.cwd();
  const dir = ensureReinsDir(here);
  // Only seed a fresh policy.json when NEITHER file exists — a pre-existing
  // guards.json (older install) is left alone; init isn't the migration
  // trigger, `reins guard add/remove` is (see saveGuards in guards.ts).
  if (!fs.existsSync(policyPath(here)) && !fs.existsSync(guardsPath(here))) {
    saveGuards({ rules: seededDefaults(), version: POLICY_VERSION }, here);
  }
  if (!fs.existsSync(configPath(here))) saveConfig(loadConfig(here), here);

  console.log(c.green("✓ Initialized ") + c.dim(dir));
  console.log(c.dim("  · policy.json   (default denylist — edit or use `reins guard`)"));
  console.log(c.dim("  · config.json   (loop threshold, etc.)"));
  console.log(c.dim("  · .gitignore    (the whole .reins dir is git-ignored)"));

  // Surface the capture capability up front — honest about Node compatibility.
  const note = capabilityNote();
  if (note) console.log(c.yellow("  ! ") + c.dim(note));
  else console.log(c.dim(`  · capture       enabled via ${getDriver()!.name}`));

  console.log("");

  // An old Claude Code loads no hooks from a file that names an event it does
  // not know, so the failure hook is left out there.
  const claude = claudeCodeVersion();
  const without = predatesFailureHook(claude) ? [FAILURE_HOOK] : [];

  if (printOnly) {
    console.log(c.bold("Add this to ") + c.cyan(".claude/settings.json") + ":");
    console.log("");
    console.log(settingsBlockJson(without));
    console.log("");
    console.log(c.dim("(Requires `npm i -g reins`, or replace `reins` with `npx reins`.)"));
  } else {
    const settingsFile = path.join(
      process.cwd(),
      ".claude",
      useLocal ? "settings.local.json" : "settings.json",
    );
    const result = mergeHooks(settingsFile, without);
    switch (result.status) {
      case "added":
        console.log(c.green("✓ Wired hooks into ") + c.cyan(rel(settingsFile)));
        console.log(c.dim("  " + result.detail));
        break;
      case "already":
        console.log(c.green("✓ Hooks already wired in ") + c.cyan(rel(settingsFile)));
        break;
      case "unparseable":
        console.log(c.red("! Could not parse ") + c.cyan(rel(settingsFile)));
        console.log(c.dim("  Left it untouched. Add this block manually:"));
        console.log("");
        console.log(settingsBlockJson(without));
        break;
    }
    if (without.length > 0) {
      console.log(c.yellow("  ! ") + c.dim(`Claude Code ${claude} is older than ${FAILURE_HOOK_SINCE} and loads no hooks from a settings file that names ${FAILURE_HOOK}.`));
      console.log(c.dim(`    That hook is left out, so failed tool calls are not captured. Run reins init again after upgrading Claude Code.`));
    } else if (claude === null) {
      console.log(c.yellow("  ! ") + c.dim(`Could not run claude --version. A Claude Code older than ${FAILURE_HOOK_SINCE} loads no hooks from this file: check with reins doctor.`));
    }
    if (withMod) reportMod(here);
    console.log("");
    console.log(c.dim("Restart Claude Code in this project so it loads the hooks."));
  }

  console.log("");
  console.log("Then, mid-run:  " + c.cyan('reins steer "focus the auth work on the token refresh path"'));
  return 0;
}

/**
 * `--mod`: copy the read-only status mod into `.claude/skills/reins-status/`,
 * where Claude Code loads it once the project is trusted. Opt-in, because the
 * mod API is early access.
 */
function reportMod(here: string): void {
  const r = installMod(here);
  const where = c.cyan(rel(r.dir));
  switch (r.status) {
    case "installed":
      console.log(c.green("✓ Installed the status mod in ") + where);
      console.log(c.dim("  Shows the hold queue inside Claude Code. Read-only: answer holds with reins approve or reins watch."));
      break;
    case "updated":
      console.log(c.green("✓ Updated the status mod in ") + where);
      break;
    case "already":
      console.log(c.green("✓ Status mod already installed in ") + where);
      break;
    case "foreign":
      console.log(c.red("! ") + where + c.dim(" exists and is not the reins mod. Left untouched."));
      break;
    case "no-source":
      console.log(c.red("! ") + c.dim("This build of reins does not include the status mod."));
      break;
  }
}

interface MergeResult {
  status: "added" | "already" | "unparseable";
  detail: string;
}

/**
 * Idempotently add reins hook entries to a Claude Code settings file. Preserves
 * everything else. Never overwrites a file it can't parse (avoids clobbering a
 * user's settings on a stray syntax error).
 */
function mergeHooks(settingsFile: string, without: string[]): MergeResult {
  let parsed: Record<string, unknown> = {};
  if (fs.existsSync(settingsFile)) {
    const raw = fs.readFileSync(settingsFile, "utf8").trim();
    if (raw) {
      try {
        parsed = JSON.parse(raw);
      } catch {
        return { status: "unparseable", detail: "" };
      }
    }
  } else {
    fs.mkdirSync(path.dirname(settingsFile), { recursive: true });
  }

  const { settings, added, removed } = mergeReinsHooks(parsed, without);
  if (added === 0 && removed === 0) return { status: "already", detail: "" };

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  const events = ["PreToolUse", "PostToolUse", "PostToolUseFailure", "Stop"].filter((e) => !without.includes(e));
  const took = removed > 0 ? ` ${without.join(", ")} removed.` : "";
  return {
    status: "added",
    detail: `${added} hook${added === 1 ? "" : "s"} added (${events.join(", ")}).${took}`,
  };
}

function rel(p: string): string {
  const r = path.relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
}
