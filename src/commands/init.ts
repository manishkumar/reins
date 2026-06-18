import * as fs from "node:fs";
import * as path from "node:path";
import { ensureReinsDir, guardsPath, configPath } from "../paths";
import { loadGuards, saveGuards } from "../guards";
import { loadConfig, saveConfig } from "../config";
import { settingsBlockJson } from "../settingsBlock";
import { mergeReinsHooks } from "../settingsMerge";
import { getDriver, capabilityNote } from "../store";
import { c } from "./format";

export function cmdInit(args: string[]): number {
  const printOnly = args.includes("--print") || args.includes("-p");
  const useLocal = args.includes("--local");

  const dir = ensureReinsDir();
  if (!fs.existsSync(guardsPath())) saveGuards(loadGuards());
  if (!fs.existsSync(configPath())) saveConfig(loadConfig());

  console.log(c.green("✓ Initialized ") + c.dim(dir));
  console.log(c.dim("  · guards.json   (default denylist — edit or use `reins guard`)"));
  console.log(c.dim("  · config.json   (loop threshold, etc.)"));
  console.log(c.dim("  · .gitignore    (the whole .reins dir is git-ignored)"));

  // Surface the capture capability up front — honest about Node compatibility.
  const note = capabilityNote();
  if (note) console.log(c.yellow("  ! ") + c.dim(note));
  else console.log(c.dim(`  · capture       enabled via ${getDriver()!.name}`));

  console.log("");

  if (printOnly) {
    console.log(c.bold("Add this to ") + c.cyan(".claude/settings.json") + ":");
    console.log("");
    console.log(settingsBlockJson());
    console.log("");
    console.log(c.dim("(Requires `npm i -g reins`, or replace `reins` with `npx reins`.)"));
  } else {
    const settingsFile = path.join(
      process.cwd(),
      ".claude",
      useLocal ? "settings.local.json" : "settings.json",
    );
    const result = mergeHooks(settingsFile);
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
        console.log(settingsBlockJson());
        break;
    }
    console.log("");
    console.log(c.dim("Restart Claude Code in this project so it loads the hooks."));
  }

  console.log("");
  console.log("Then, mid-run:  " + c.cyan('reins steer "focus the auth work on the token refresh path"'));
  return 0;
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
function mergeHooks(settingsFile: string): MergeResult {
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

  const { settings, added } = mergeReinsHooks(parsed);
  if (added === 0) return { status: "already", detail: "" };

  fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2) + "\n");
  return {
    status: "added",
    detail: `${added} hook${added === 1 ? "" : "s"} added (PreToolUse, PostToolUse, Stop).`,
  };
}

function rel(p: string): string {
  const r = path.relative(process.cwd(), p);
  return r.startsWith("..") ? p : r;
}
