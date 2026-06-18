import * as fs from "node:fs";
import * as path from "node:path";
import { unmergeReinsHooks } from "../settingsMerge";
import { reinsDir } from "../paths";
import { c } from "./format";

/**
 * Remove reins hooks from the project's Claude Code settings. Leaves the .reins
 * data dir in place by default (your trajectory log is yours); --purge removes
 * it too.
 */
export function cmdUninstall(args: string[]): number {
  const purge = args.includes("--purge");

  let touched = 0;
  for (const name of ["settings.json", "settings.local.json"]) {
    const file = path.join(process.cwd(), ".claude", name);
    if (!fs.existsSync(file)) continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(fs.readFileSync(file, "utf8") || "{}");
    } catch {
      console.log(c.red("! ") + c.cyan(name) + c.dim(" is not valid JSON — left untouched."));
      continue;
    }
    const { settings, removed } = unmergeReinsHooks(parsed);
    if (removed > 0) {
      fs.writeFileSync(file, JSON.stringify(settings, null, 2) + "\n");
      console.log(c.green(`✓ Removed ${removed} reins hook${removed === 1 ? "" : "s"} from `) + c.cyan(name));
      touched += removed;
    }
  }

  if (touched === 0) {
    console.log(c.dim("No reins hooks found in .claude/settings.json or settings.local.json."));
  }

  const dir = reinsDir();
  if (purge && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(c.green("✓ Removed ") + c.cyan(".reins/") + c.dim(" (data + config)"));
  } else if (fs.existsSync(dir)) {
    console.log(c.dim(`Your data is kept in ${dir}. Remove it with: reins uninstall --purge`));
  }

  console.log(c.dim("Restart Claude Code to unload the hooks."));
  return 0;
}
