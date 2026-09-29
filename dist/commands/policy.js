"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdPolicy = cmdPolicy;
const guards_1 = require("../guards");
const policyUpgrade_1 = require("../policyUpgrade");
const paths_1 = require("../paths");
const format_1 = require("./format");
function cmdPolicy(args) {
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
function cmdPolicyVersion() {
    const file = (0, guards_1.loadGuards)();
    const plan = (0, policyUpgrade_1.planUpgrade)(file);
    const from = file.version === undefined ? "unversioned (pre-0.4)" : `v${file.version}`;
    console.log(format_1.c.bold("Binary") + format_1.c.dim("  (shared by every project — hooks call bare `reins`)"));
    console.log(`  reins version   ${reinsVersion()}`);
    console.log(`  running from    ${format_1.c.dim(process.argv[1] || "?")}`);
    console.log("");
    console.log(format_1.c.bold("This project") + format_1.c.dim("  " + (0, paths_1.reinsDir)()));
    console.log(`  policy source   ${(0, guards_1.policySource)() === "defaults" ? "built-in defaults" : ".reins/" + (0, guards_1.policySource)()}`);
    console.log(`  policy version  ${from}`);
    console.log(`  shipped version v${guards_1.POLICY_VERSION}`);
    console.log(`  rules           ${file.rules.length} (${plan.userRuleIds.length} your own)`);
    console.log("");
    if ((0, policyUpgrade_1.hasWork)(plan)) {
        const added = plan.changes.filter((ch) => ch.kind === "added").length;
        const updated = plan.changes.filter((ch) => ch.kind === "updated").length;
        console.log(format_1.c.yellow("!") +
            ` Rules are behind: ${updated} changed, ${added} new. ` +
            format_1.c.dim("Run `reins policy upgrade` to see the diff."));
    }
    else {
        console.log(format_1.c.green("✓") + " Rules are current.");
    }
    return 0;
}
function reinsVersion() {
    try {
        return require("../../package.json").version;
    }
    catch {
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
function cmdPolicyUpgrade(args) {
    const apply = args.includes("--apply");
    const file = (0, guards_1.loadGuards)();
    const plan = (0, policyUpgrade_1.planUpgrade)(file);
    if (!(0, policyUpgrade_1.hasWork)(plan)) {
        console.log(`${format_1.c.green("✓")} Policy is up to date ` +
            format_1.c.dim(`(v${plan.toVersion}, ${plan.userRuleIds.length} of your own rules untouched)`));
        if (plan.customizedRuleIds.length > 0) {
            console.log(format_1.c.dim(`  Shipped rules you've customized (left as you wrote them): ${plan.customizedRuleIds.join(", ")}`));
        }
        return 0;
    }
    printPlan(plan);
    if (!apply) {
        console.log("");
        console.log(format_1.c.dim("Nothing written. Re-run with --apply to make these changes."));
        return 0;
    }
    (0, guards_1.saveGuards)({ rules: plan.nextRules, version: guards_1.POLICY_VERSION });
    console.log("");
    console.log(`${format_1.c.green("✓")} Wrote .reins/policy.json ` + format_1.c.dim(`(now v${guards_1.POLICY_VERSION})`));
    if (plan.userRuleIds.length > 0) {
        console.log(format_1.c.dim(`  Your own rules were left alone: ${plan.userRuleIds.join(", ")}`));
    }
    return 0;
}
function printPlan(plan) {
    const from = plan.fromVersion === undefined ? "unversioned" : `v${plan.fromVersion}`;
    console.log(format_1.c.bold(`Policy upgrade  ${from} → v${plan.toVersion}`));
    console.log("");
    for (const change of plan.changes) {
        if (change.kind === "unchanged")
            continue;
        const sym = change.kind === "added" ? format_1.c.green("+") : format_1.c.yellow("~");
        console.log(`  ${sym} ${change.id.padEnd(26)} ${format_1.c.dim(change.details.join(", "))}`);
        if (change.kind === "updated" && change.before) {
            if (change.before.pattern !== change.after.pattern) {
                console.log(format_1.c.dim(`      - ${change.before.pattern}`));
                console.log(format_1.c.dim(`      + ${change.after.pattern}`));
            }
            const beforeExcept = change.before.except ?? [];
            const afterExcept = change.after.except ?? [];
            for (const e of afterExcept.filter((x) => !beforeExcept.includes(x))) {
                console.log(format_1.c.dim(`      + except: ${e}`));
            }
        }
        if (change.kind === "added") {
            console.log(format_1.c.dim(`      ${change.after.reason}`));
        }
        if (change.unknownProvenance) {
            // No `origin` on the on-disk rule, so reins cannot tell a rule that is
            // merely old from one you re-tuned by hand. It refreshes rather than
            // freezes — a stale safety rule that can never be fixed is the worse
            // failure — but you get the diff first, and a way to opt out for good.
            console.log(format_1.c.dim(`      (no origin recorded — if this pattern is yours, add "origin": "user" to keep it)`));
        }
    }
    const unchanged = plan.changes.filter((ch) => ch.kind === "unchanged").length;
    console.log("");
    if (unchanged > 0)
        console.log(format_1.c.dim(`  ${unchanged} shipped rule(s) already current.`));
    if (plan.customizedRuleIds.length > 0) {
        console.log(format_1.c.dim(`  ${plan.customizedRuleIds.length} shipped rule(s) you've customized, left alone: ${plan.customizedRuleIds.join(", ")}`));
    }
    if (plan.userRuleIds.length > 0) {
        console.log(format_1.c.dim(`  ${plan.userRuleIds.length} rule(s) you wrote will not be touched: ${plan.userRuleIds.join(", ")}`));
    }
}
