import { loadGuards, saveGuards, policySource, POLICY_VERSION } from "../guards";
import { planUpgrade, hasWork, UpgradePlan } from "../policyUpgrade";
import { reinsDir } from "../paths";
import { c } from "./format";

export function cmdPolicy(args: string[]): number {
  const sub = args[0];
  switch (sub) {
    case "upgrade":
      return cmdPolicyUpgrade(args.slice(1));
    case "version":
      return cmdPolicyVersion();
    default:
      console.error(`reins policy: unknown subcommand "${sub ?? ""}"`);
      console.error("usage: reins policy upgrade [--apply] | reins policy version");
      return 1;
  }
}

/**
 * What is this project actually running?
 *
 * Two versions, and conflating them is the natural mistake: a project does NOT
 * pin a reins version. The hooks invoke bare `reins`, so the BINARY is whatever
 * is on PATH — shared by every repo on the machine. What a project does carry is
 * its POLICY generation, written once at init and frozen there until someone
 * upgrades it. So "this repo is on an old reins" is almost always really "this
 * repo's rules are old", and those are fixed by different commands.
 */
function cmdPolicyVersion(): number {
  const file = loadGuards();
  const plan = planUpgrade(file);
  const from = file.version === undefined ? "unversioned (pre-0.4)" : `v${file.version}`;

  console.log(c.bold("Binary") + c.dim("  (shared by every project — hooks call bare `reins`)"));
  console.log(`  reins version   ${reinsVersion()}`);
  console.log(`  running from    ${c.dim(process.argv[1] || "?")}`);
  console.log("");
  console.log(c.bold("This project") + c.dim("  " + reinsDir()));
  console.log(`  policy source   ${policySource() === "defaults" ? "built-in defaults" : ".reins/" + policySource()}`);
  console.log(`  policy version  ${from}`);
  console.log(`  shipped version v${POLICY_VERSION}`);
  console.log(`  rules           ${file.rules.length} (${plan.userRuleIds.length} your own)`);
  console.log("");
  if (hasWork(plan)) {
    const added = plan.changes.filter((ch) => ch.kind === "added").length;
    const updated = plan.changes.filter((ch) => ch.kind === "updated").length;
    console.log(
      c.yellow("!") +
        ` Rules are behind: ${updated} changed, ${added} new. ` +
        c.dim("Run `reins policy upgrade` to see the diff."),
    );
  } else {
    console.log(c.green("✓") + " Rules are current.");
  }
  return 0;
}

function reinsVersion(): string {
  try {
    return (require("../../package.json") as { version: string }).version;
  } catch {
    return "unknown";
  }
}

/**
 * Show what upgrading would change; write only with --apply.
 *
 * The diff-first shape is not politeness, it's the invariant: reins never
 * clobbers a file the human owns. An upgrade rewrites rules the user can see
 * in their own policy.json, so they get to read the change before it lands —
 * and a rule they deliberately re-tuned (action, expires) survives regardless.
 */
function cmdPolicyUpgrade(args: string[]): number {
  const apply = args.includes("--apply");
  const file = loadGuards();
  const plan = planUpgrade(file);

  if (!hasWork(plan)) {
    console.log(
      `${c.green("✓")} Policy is up to date ` +
        c.dim(`(v${plan.toVersion}, ${plan.userRuleIds.length} of your own rules untouched)`),
    );
    if (plan.customizedRuleIds.length > 0) {
      console.log(c.dim(`  Shipped rules you've customized (left as you wrote them): ${plan.customizedRuleIds.join(", ")}`));
    }
    return 0;
  }

  printPlan(plan);

  if (!apply) {
    console.log("");
    console.log(c.dim("Nothing written. Re-run with --apply to make these changes."));
    return 0;
  }

  saveGuards({ rules: plan.nextRules, version: POLICY_VERSION });
  console.log("");
  console.log(`${c.green("✓")} Wrote .reins/policy.json ` + c.dim(`(now v${POLICY_VERSION})`));
  if (plan.userRuleIds.length > 0) {
    console.log(c.dim(`  Your own rules were left alone: ${plan.userRuleIds.join(", ")}`));
  }
  return 0;
}

function printPlan(plan: UpgradePlan): void {
  const from = plan.fromVersion === undefined ? "unversioned" : `v${plan.fromVersion}`;
  console.log(c.bold(`Policy upgrade  ${from} → v${plan.toVersion}`));
  console.log("");

  for (const change of plan.changes) {
    if (change.kind === "unchanged") continue;
    const sym = change.kind === "added" ? c.green("+") : c.yellow("~");
    console.log(`  ${sym} ${change.id.padEnd(26)} ${c.dim(change.details.join(", "))}`);
    if (change.kind === "updated" && change.before) {
      if (change.before.pattern !== change.after.pattern) {
        console.log(c.dim(`      - ${change.before.pattern}`));
        console.log(c.dim(`      + ${change.after.pattern}`));
      }
      const beforeExcept = change.before.except ?? [];
      const afterExcept = change.after.except ?? [];
      for (const e of afterExcept.filter((x) => !beforeExcept.includes(x))) {
        console.log(c.dim(`      + except: ${e}`));
      }
    }
    if (change.kind === "added") {
      console.log(c.dim(`      ${change.after.reason}`));
    }
  }

  const unchanged = plan.changes.filter((ch) => ch.kind === "unchanged").length;
  console.log("");
  if (unchanged > 0) console.log(c.dim(`  ${unchanged} shipped rule(s) already current.`));
  if (plan.customizedRuleIds.length > 0) {
    console.log(c.dim(`  ${plan.customizedRuleIds.length} shipped rule(s) you've customized, left alone: ${plan.customizedRuleIds.join(", ")}`));
  }
  if (plan.userRuleIds.length > 0) {
    console.log(c.dim(`  ${plan.userRuleIds.length} rule(s) you wrote will not be touched: ${plan.userRuleIds.join(", ")}`));
  }
}
