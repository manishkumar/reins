import * as crypto from "node:crypto";
import { loadGuards, saveGuards, DEFAULT_RULES, GuardRule, GuardType } from "../guards";
import { c } from "./format";

export function cmdGuard(args: string[]): number {
  const sub = args[0];
  switch (sub) {
    case "list":
    case undefined:
      return list();
    case "add":
      return add(args.slice(1));
    case "remove":
    case "rm":
      return remove(args.slice(1));
    case "reset":
      return reset();
    default:
      console.error(c.red(`Unknown: reins guard ${sub}`));
      console.error("Try: reins guard [list|add|remove|reset]");
      return 1;
  }
}

function list(): number {
  const guards = loadGuards();
  if (guards.rules.length === 0) {
    console.log(c.dim("No guard rules. (Add one: reins guard add bash '<regex>')"));
    return 0;
  }
  console.log(c.bold("Guard rules — hard vetoes (the agent physically cannot proceed):"));
  for (const r of guards.rules) {
    const tag = r.type === "bash" ? c.magenta("bash ") : c.blue("path ");
    console.log(`  ${c.dim(r.id.padEnd(20))} ${tag} ${c.cyan(r.pattern)}`);
    console.log(`  ${" ".repeat(20)}       ${c.dim(r.reason)}`);
  }
  return 0;
}

function add(args: string[]): number {
  const type = args[0] as GuardType;
  if (type !== "bash" && type !== "path") {
    console.error(c.red("Usage: reins guard add <bash|path> <pattern> [--reason \"...\"]"));
    console.error(c.dim("  bash <regex>  matches the command of a Bash tool call"));
    console.error(c.dim("  path <glob>   matches file paths (e.g. **/.env, secrets/**)"));
    return 1;
  }
  const reasonIdx = args.findIndex((a) => a === "--reason" || a === "-r");
  let reason = "";
  let patternParts = args.slice(1);
  if (reasonIdx >= 0) {
    reason = args.slice(reasonIdx + 1).join(" ").trim();
    patternParts = args.slice(1, reasonIdx);
  }
  const pattern = patternParts.join(" ").trim();
  if (!pattern) {
    console.error(c.red("Missing pattern."));
    return 1;
  }
  if (!reason) {
    reason =
      type === "bash"
        ? `Command matching /${pattern}/ is blocked by a reins guard.`
        : `Touching ${pattern} is blocked by a reins guard.`;
  }

  const guards = loadGuards();
  const id = makeId(type, pattern, guards.rules.map((r) => r.id));
  const rule: GuardRule = { id, type, pattern, reason };
  guards.rules.push(rule);
  saveGuards(guards);
  console.log(c.green(`✓ Added guard ${c.bold(id)}`));
  console.log(`  ${rule.type} ${c.cyan(rule.pattern)} — ${c.dim(rule.reason)}`);
  return 0;
}

function remove(args: string[]): number {
  const id = args[0];
  if (!id) {
    console.error(c.red("Usage: reins guard remove <id>   (see ids via: reins guard list)"));
    return 1;
  }
  const guards = loadGuards();
  const before = guards.rules.length;
  guards.rules = guards.rules.filter((r) => r.id !== id);
  if (guards.rules.length === before) {
    console.error(c.red(`No guard with id "${id}".`));
    return 1;
  }
  saveGuards(guards);
  console.log(c.green(`✓ Removed guard ${id}`));
  return 0;
}

function reset(): number {
  saveGuards({ rules: [...DEFAULT_RULES] });
  console.log(c.green("✓ Guards reset to the built-in defaults."));
  return 0;
}

function makeId(type: GuardType, pattern: string, existing: string[]): string {
  const slug = pattern
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 16);
  let base = `${type}-${slug || "rule"}`;
  if (!existing.includes(base)) return base;
  const suffix = crypto.createHash("sha1").update(pattern).digest("hex").slice(0, 4);
  return `${base}-${suffix}`;
}
