"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.seededDefaults = seededDefaults;
exports.planUpgrade = planUpgrade;
exports.hasWork = hasWork;
exports.stalenessNote = stalenessNote;
const guards_1 = require("./guards");
/** Stamp the shipped rules with their provenance, ready to write to disk. */
function seededDefaults() {
    return guards_1.DEFAULT_RULES.map((r) => ({ ...r, origin: `default@${guards_1.POLICY_VERSION}` }));
}
/** True if a rule was seeded from DEFAULT_RULES rather than hand-written.
 *
 *  Pre-0.4 files carry no `origin` at all, so a bare id match against the
 *  shipped set stands in for it. That's the whole reason existing installs are
 *  upgradeable instead of stranded — which is the bug this module is here for. */
function isDefaultRule(rule, defaultIds) {
    if (typeof rule.origin === "string")
        return rule.origin.startsWith("default@");
    return defaultIds.has(rule.id);
}
function sameStringArray(a, b) {
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
function mergeRule(current, shipped) {
    const details = [];
    const next = {
        ...shipped,
        origin: `default@${guards_1.POLICY_VERSION}`,
    };
    if (current.action !== undefined && current.action !== shipped.action) {
        next.action = current.action;
        details.push(`keeping your action "${current.action}"`);
    }
    if (current.expires !== undefined) {
        next.expires = current.expires;
        details.push(`keeping your expires "${current.expires}"`);
    }
    if (current.pattern !== shipped.pattern)
        details.push("pattern changed");
    if (!sameStringArray(current.except, shipped.except)) {
        const from = current.except?.length ?? 0;
        const to = shipped.except?.length ?? 0;
        details.push(`exemptions ${from} → ${to}`);
    }
    if (current.reason !== shipped.reason)
        details.push("reason reworded");
    if (current.type !== shipped.type)
        details.push(`type ${current.type} → ${shipped.type}`);
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
function planUpgrade(file) {
    const defaultIds = new Set(guards_1.DEFAULT_RULES.map((r) => r.id));
    const changes = [];
    const customizedRuleIds = [];
    const next = [...file.rules];
    // Already at the shipped generation? Then nothing new has been published, so
    // any content difference in a shipped rule came from the user. Refreshing it
    // would silently undo their edit — the exact clobber this module refuses to
    // do. New rules still get offered; existing ones are left as written.
    const atCurrentGeneration = file.version === guards_1.POLICY_VERSION;
    for (let i = 0; i < guards_1.DEFAULT_RULES.length; i++) {
        const shipped = guards_1.DEFAULT_RULES[i];
        const at = next.findIndex((r) => r.id === shipped.id);
        if (at === -1) {
            // A newly shipped rule. Place it just before the next shipped rule that
            // already exists on disk, preserving DEFAULT_RULES' relative ordering.
            let insertAt = next.length;
            for (let j = i + 1; j < guards_1.DEFAULT_RULES.length; j++) {
                const k = next.findIndex((r) => r.id === guards_1.DEFAULT_RULES[j].id);
                if (k >= 0) {
                    insertAt = k;
                    break;
                }
            }
            const after = { ...shipped, origin: `default@${guards_1.POLICY_VERSION}` };
            next.splice(insertAt, 0, after);
            changes.push({ id: shipped.id, kind: "added", details: ["new rule"], after });
            continue;
        }
        const current = next[at];
        // A rule the user renamed into or wrote themselves that happens to collide
        // with a shipped id is still theirs if it says so.
        if (!isDefaultRule(current, defaultIds))
            continue;
        const { next: merged, details } = mergeRule(current, shipped);
        const substantive = details.filter((d) => !d.startsWith("keeping your"));
        if (substantive.length > 0 && atCurrentGeneration) {
            customizedRuleIds.push(shipped.id); // their edit, not our staleness
            continue; // leave next[at] exactly as the user wrote it
        }
        next[at] = merged;
        changes.push({
            id: shipped.id,
            kind: substantive.length > 0 ? "updated" : "unchanged",
            details,
            before: current,
            after: merged,
        });
    }
    const userRuleIds = file.rules.filter((r) => !isDefaultRule(r, defaultIds)).map((r) => r.id);
    return {
        fromVersion: file.version,
        toVersion: guards_1.POLICY_VERSION,
        changes,
        userRuleIds,
        customizedRuleIds,
        nextRules: next,
    };
}
/** True if there is anything worth writing — new rules or changed ones. */
function hasWork(plan) {
    return plan.changes.some((c) => c.kind !== "unchanged");
}
/** One-line staleness summary for `reins doctor`. */
function stalenessNote(plan) {
    if (!hasWork(plan))
        return null;
    const added = plan.changes.filter((c) => c.kind === "added").length;
    const updated = plan.changes.filter((c) => c.kind === "updated").length;
    const parts = [];
    if (updated > 0)
        parts.push(`${updated} rule${updated === 1 ? "" : "s"} changed upstream`);
    if (added > 0)
        parts.push(`${added} new rule${added === 1 ? "" : "s"} available`);
    const from = plan.fromVersion === undefined ? "pre-versioning" : `v${plan.fromVersion}`;
    return `${parts.join(", ")} (${from} → v${plan.toVersion}) — run \`reins policy upgrade\``;
}
