// Delivering rule changes to installs that already exist.
//
// This module exists because of a measured failure. A repo initialized in June
// 2026 was still enforcing June's rules in late July — including a recursive-rm
// pattern that blocked plain `rm -f one-file.txt`. That bug had been fixed
// upstream weeks earlier and reached nobody, because `reins init` wrote the
// rules once and nothing ever revisited them. Every install was a frozen
// snapshot of whatever the denylist looked like the day it was created.
//
// The fix has to respect the same invariant `reins init` does: never clobber
// what the human wrote. So an upgrade is a two-step — compute a plan, show it,
// and only write when explicitly asked. Nothing here mutates on its own.

import { GuardRule, GuardsFile, DEFAULT_RULES, POLICY_VERSION } from "./guards";

export type ChangeKind = "added" | "updated" | "unchanged";

export interface RuleChange {
  id: string;
  kind: ChangeKind;
  /** Field-level description of what differs, for the diff output. */
  details: string[];
  before?: GuardRule;
  after: GuardRule;
  /** The on-disk rule carried no `origin`, so "stale" and "you edited this"
   *  are indistinguishable — the upgrade refreshes it and says so, rather than
   *  freezing a possibly-stale safety rule on a guess. Only ever true on a
   *  change the user gets to read before anything is written. */
  unknownProvenance?: boolean;
}

export interface UpgradePlan {
  /** Policy generation currently on disk (undefined for a pre-versioning file). */
  fromVersion?: number;
  toVersion: number;
  changes: RuleChange[];
  /** Rules with no counterpart in DEFAULT_RULES — hand-written, never touched. */
  userRuleIds: string[];
  /** Shipped rules the user has since edited themselves. Detected per rule: the
   *  rule's own `origin` says it was written at the current generation, yet its
   *  content differs — nothing new has shipped, so the difference came from
   *  them. Left alone, and reported so the divergence isn't invisible. */
  customizedRuleIds: string[];
  /** The full rule list as it would be written. Only meaningful when applying. */
  nextRules: GuardRule[];
}

/** Stamp the shipped rules with their provenance, ready to write to disk. */
export function seededDefaults(): GuardRule[] {
  return DEFAULT_RULES.map((r) => ({ ...r, origin: `default@${POLICY_VERSION}` }));
}

/** True if a rule was seeded from DEFAULT_RULES rather than hand-written.
 *
 *  Pre-0.4 files carry no `origin` at all, so a bare id match against the
 *  shipped set stands in for it. That's the whole reason existing installs are
 *  upgradeable instead of stranded — which is the bug this module is here for. */
function isDefaultRule(rule: GuardRule, defaultIds: Set<string>): boolean {
  if (typeof rule.origin === "string") return rule.origin.startsWith("default@");
  return defaultIds.has(rule.id);
}

/**
 * Which generation wrote THIS RULE's body, or null if the rule can't say.
 *
 * Staleness is a property of a rule, not of the file it lives in — and reading
 * it off the file is what froze real installs. `saveGuards` used to stamp any
 * unversioned file with the current generation, so a repo could sit at "v2"
 * carrying June's rule bodies; the file-level check then read that stamp,
 * concluded nothing new had shipped, and filed every stale rule under "the user
 * customized this" — permanently, since the version could never fall behind
 * again. Asking the rule instead makes that state self-healing: a body with no
 * origin, or an older one, is stale no matter what the file claims.
 */
function ruleGeneration(rule: GuardRule): number | null {
  const m = /^default@(\d+)$/.exec(rule.origin ?? "");
  return m ? Number(m[1]) : null;
}

function sameStringArray(a?: string[], b?: string[]): boolean {
  const x = a ?? [];
  const y = b ?? [];
  return x.length === y.length && x.every((v, i) => v === y[i]);
}

/**
 * Compare one on-disk rule against its shipped counterpart.
 *
 * `action` is deliberately NOT overwritten. It's the field a human is most
 * likely to have changed on purpose — downgrading a deny to ask, or promoting
 * something to hold — and silently resetting that to the shipped default would
 * be exactly the clobber `reins init` is careful never to do. The same goes for
 * `expires`: a temporary suspension the user set should survive an upgrade.
 */
function mergeRule(current: GuardRule, shipped: GuardRule): { next: GuardRule; details: string[] } {
  const details: string[] = [];
  const next: GuardRule = {
    ...shipped,
    origin: `default@${POLICY_VERSION}`,
  };

  if (current.action !== undefined && current.action !== shipped.action) {
    next.action = current.action;
    details.push(`keeping your action "${current.action}"`);
  }
  if (current.expires !== undefined) {
    next.expires = current.expires;
    details.push(`keeping your expires "${current.expires}"`);
  }

  if (current.pattern !== shipped.pattern) details.push("pattern changed");
  if (!sameStringArray(current.except, shipped.except)) {
    const from = current.except?.length ?? 0;
    const to = shipped.except?.length ?? 0;
    details.push(`exemptions ${from} → ${to}`);
  }
  if (current.reason !== shipped.reason) details.push("reason reworded");
  if (current.type !== shipped.type) details.push(`type ${current.type} → ${shipped.type}`);

  return { next, details };
}

/**
 * Work out what upgrading this policy file would do.
 *
 * Rule ORDER is load-bearing: `checkGuards` returns the first match, so
 * `rm-catastrophic` sitting ahead of `rm-rf` is what stops a generous exemption
 * list from waving through `rm -rf /`. New shipped rules are therefore inserted
 * at their canonical position relative to their neighbours rather than appended,
 * and existing rules keep the slot the user put them in.
 */
export function planUpgrade(file: GuardsFile): UpgradePlan {
  const defaultIds = new Set(DEFAULT_RULES.map((r) => r.id));
  const changes: RuleChange[] = [];
  const customizedRuleIds: string[] = [];
  const next: GuardRule[] = [...file.rules];

  for (let i = 0; i < DEFAULT_RULES.length; i++) {
    const shipped = DEFAULT_RULES[i];
    const at = next.findIndex((r) => r.id === shipped.id);

    if (at === -1) {
      // A newly shipped rule. Place it just before the next shipped rule that
      // already exists on disk, preserving DEFAULT_RULES' relative ordering.
      let insertAt = next.length;
      for (let j = i + 1; j < DEFAULT_RULES.length; j++) {
        const k = next.findIndex((r) => r.id === DEFAULT_RULES[j].id);
        if (k >= 0) {
          insertAt = k;
          break;
        }
      }
      const after: GuardRule = { ...shipped, origin: `default@${POLICY_VERSION}` };
      next.splice(insertAt, 0, after);
      changes.push({ id: shipped.id, kind: "added", details: ["new rule"], after });
      continue;
    }

    const current = next[at];
    // A rule the user renamed into or wrote themselves that happens to collide
    // with a shipped id is still theirs if it says so.
    if (!isDefaultRule(current, defaultIds)) continue;

    const { next: merged, details } = mergeRule(current, shipped);
    const substantive = details.filter((d) => !d.startsWith("keeping your"));

    // Content differs, and the rule itself says it was written at the current
    // generation: nothing has shipped since, so the difference is the user's
    // edit. Left exactly as they wrote it, and reported so it isn't invisible.
    if (substantive.length > 0 && ruleGeneration(current) === POLICY_VERSION) {
      customizedRuleIds.push(shipped.id);
      continue;
    }

    next[at] = merged;
    changes.push({
      id: shipped.id,
      kind: substantive.length > 0 ? "updated" : "unchanged",
      details,
      before: current,
      after: merged,
      unknownProvenance: substantive.length > 0 && ruleGeneration(current) === null,
    });
  }

  const userRuleIds = file.rules.filter((r) => !isDefaultRule(r, defaultIds)).map((r) => r.id);

  return {
    fromVersion: file.version,
    toVersion: POLICY_VERSION,
    changes,
    userRuleIds,
    customizedRuleIds,
    nextRules: next,
  };
}

/** True if there is anything worth writing — new rules or changed ones. */
export function hasWork(plan: UpgradePlan): boolean {
  return plan.changes.some((c) => c.kind !== "unchanged");
}

/** One-line staleness summary for `reins doctor`. */
export function stalenessNote(plan: UpgradePlan): string | null {
  if (!hasWork(plan)) return null;
  const added = plan.changes.filter((c) => c.kind === "added").length;
  const updated = plan.changes.filter((c) => c.kind === "updated").length;
  const parts: string[] = [];
  if (updated > 0) parts.push(`${updated} rule${updated === 1 ? "" : "s"} changed upstream`);
  if (added > 0) parts.push(`${added} new rule${added === 1 ? "" : "s"} available`);
  // "v2 → v2" reads like a no-op, which is precisely the case worth naming: the
  // file is stamped current while its rule bodies are not. Say that instead.
  const where =
    plan.fromVersion === plan.toVersion
      ? `stamped v${plan.toVersion}, rule bodies older`
      : `${plan.fromVersion === undefined ? "pre-versioning" : `v${plan.fromVersion}`} → v${plan.toVersion}`;
  return `${parts.join(", ")} (${where}) — run \`reins policy upgrade\``;
}
