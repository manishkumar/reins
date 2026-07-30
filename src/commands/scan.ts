import * as fs from "node:fs";
import * as path from "node:path";
import { loadGuards, saveGuards, GuardRule } from "../guards";
import { reinsDir, ensureReinsDir } from "../paths";
import { scanRepo } from "../scan";
import { c } from "./format";

function suggestedPath(cwd?: string): string {
  return path.join(reinsDir(cwd), "suggested.json");
}

/**
 * `reins scan` — propose rules aimed at what THIS repo can destroy.
 *
 * Two steps by design. The scan writes proposals to .reins/suggested.json and
 * changes nothing; `reins scan --accept` moves them into the active policy.
 * Making the review structural rather than advisory is the point: the first
 * generated rule that breaks someone's build is the last generated rule they
 * ever trust, so nothing here may activate itself.
 */
export function cmdScan(args: string[]): number {
  const accept = args.includes("--accept");
  const guards = loadGuards();
  const result = scanRepo(undefined, guards.rules);

  if (result.detections.length === 0) {
    console.log(c.dim("No known stacks detected in ") + result.root);
    console.log(c.dim("reins scan reads manifests only (package.json, prisma/, *.tf, k8s/, .env, …)."));
    return 0;
  }

  console.log(c.bold("reins scan") + c.dim("  " + result.root));
  console.log("");
  console.log(c.bold("Detected"));
  for (const d of result.detections) {
    console.log(`  ${c.green("•")} ${d.id.padEnd(14)} ${c.dim(d.evidence)}`);
  }

  if (result.newRules.length === 0) {
    console.log("");
    console.log(`${c.green("✓")} Every suggested rule is already in your policy.`);
    return 0;
  }

  console.log("");
  console.log(c.bold(`Proposed (${result.newRules.length})`));
  for (const r of result.newRules) {
    console.log(`  ${c.yellow(r.action ?? "hold")} ${r.id.padEnd(28)} ${c.dim(r.reason)}`);
    console.log(c.dim(`      ${r.pattern}`));
  }
  if (result.alreadyPresent.length > 0) {
    console.log(c.dim(`  (${result.alreadyPresent.length} already present: ${result.alreadyPresent.join(", ")})`));
  }

  console.log("");
  console.log(
    c.dim(
      "These are proposals, not rules. Nothing is enforced until you accept them.\n" +
        "None is a `deny` — a generated rule is a guess, and a wrong veto in your own\n" +
        "run costs more than a missed pattern. Promote one to deny yourself if you mean it.",
    ),
  );

  if (!accept) {
    writeSuggestions(result.newRules);
    console.log("");
    console.log(`Wrote ${c.bold(".reins/suggested.json")} — review it, then:`);
    console.log(c.dim("  reins scan --accept        add them all to your policy"));
    console.log(c.dim("  (or copy the ones you want into .reins/policy.json by hand)"));
    return 0;
  }

  const next = [...result.newRules, ...guards.rules];
  saveGuards({ ...guards, rules: next });
  try {
    fs.rmSync(suggestedPath(), { force: true });
  } catch {
    /* the staging file is a convenience, not state */
  }
  console.log("");
  console.log(`${c.green("✓")} Added ${result.newRules.length} rule(s) to .reins/policy.json`);
  console.log(c.dim("  Review with `reins guard list`; remove any with `reins guard remove <id>`."));
  return 0;
}

function writeSuggestions(rules: GuardRule[]): void {
  try {
    ensureReinsDir();
    fs.writeFileSync(suggestedPath(), JSON.stringify({ rules }, null, 2) + "\n");
  } catch (e) {
    console.error(c.yellow("! could not write .reins/suggested.json: ") + String(e));
  }
}
