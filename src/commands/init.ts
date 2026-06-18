import * as fs from "node:fs";
import { ensureReinsDir, guardsPath, configPath } from "../paths";
import { loadGuards, saveGuards } from "../guards";
import { loadConfig, saveConfig } from "../config";
import { settingsBlockJson } from "../settingsBlock";
import { c } from "./format";

export function cmdInit(): number {
  const dir = ensureReinsDir();

  // Materialize config + guards so they're visible and editable on disk.
  if (!fs.existsSync(guardsPath())) saveGuards(loadGuards());
  if (!fs.existsSync(configPath())) saveConfig(loadConfig());

  console.log(c.green("✓ Initialized ") + c.dim(dir));
  console.log(c.dim("  · guards.json   (default denylist — edit or use `reins guard`)"));
  console.log(c.dim("  · config.json   (loop threshold, etc.)"));
  console.log(c.dim("  · .gitignore    (the whole .reins dir is git-ignored)"));
  console.log("");
  console.log(c.bold("Now wire the hooks.") + " Add this to " + c.cyan(".claude/settings.json") + ":");
  console.log("");
  console.log(settingsBlockJson());
  console.log("");
  console.log(c.dim("(Requires `npm i -g reins`, or replace `reins` with `npx reins`.)"));
  console.log("");
  console.log("Then, mid-run:  " + c.cyan('reins steer "focus the auth work on the token refresh path"'));
  return 0;
}
