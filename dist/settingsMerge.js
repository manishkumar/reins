"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.mergeReinsHooks = mergeReinsHooks;
exports.unmergeReinsHooks = unmergeReinsHooks;
const settingsBlock_1 = require("./settingsBlock");
/**
 * Idempotently ensure reins hook entries exist in a parsed Claude Code settings
 * object. Pure function (no IO) so it's easy to test. Preserves all existing
 * keys and any unrelated hooks the user already has.
 *
 * `without` names events this Claude Code does not know. reins does not add
 * them, and takes out its own entry if an earlier init wrote one, because an
 * unknown event makes an old Claude Code load no hooks at all. A hook of the
 * user's own under that event is theirs and stays.
 */
function mergeReinsHooks(input, without = [], 
/** False leaves an existing entry for a `without` event alone: the version is unknown, so nothing is known to be wrong with it. */
strip = true) {
    const settings = { ...(input ?? {}) };
    const hooks = { ...(settings.hooks ?? {}) };
    let added = 0;
    let removed = 0;
    for (const event of strip ? without : []) {
        if (!Array.isArray(hooks[event]))
            continue;
        const kept = hooks[event].filter((e) => !(e.hooks ?? []).some((h) => (h.command ?? "").includes("reins hook")));
        removed += hooks[event].length - kept.length;
        if (kept.length === 0)
            delete hooks[event];
        else
            hooks[event] = kept;
    }
    for (const [event, desired] of Object.entries(settingsBlock_1.SETTINGS_BLOCK.hooks)) {
        if (without.includes(event))
            continue;
        const existing = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
        for (const wantEntry of desired) {
            const wantCmd = wantEntry.hooks[0].command;
            const present = existing.some((e) => (e.hooks ?? []).some((h) => h.command === wantCmd));
            if (!present) {
                existing.push(wantEntry);
                added++;
            }
        }
        hooks[event] = existing;
    }
    settings.hooks = hooks;
    return { settings, added, removed };
}
/**
 * Remove reins hook entries from a parsed settings object, leaving any other
 * hooks (and all other keys) intact. Empty hook arrays/objects are pruned so
 * the file stays tidy. Pure function — easy to test.
 */
function unmergeReinsHooks(input) {
    const settings = { ...(input ?? {}) };
    const hooks = { ...(settings.hooks ?? {}) };
    let removed = 0;
    for (const event of Object.keys(hooks)) {
        const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
        const kept = entries.filter((e) => {
            const isReins = (e.hooks ?? []).some((h) => (h.command ?? "").includes("reins hook"));
            if (isReins)
                removed++;
            return !isReins;
        });
        if (kept.length === 0)
            delete hooks[event];
        else
            hooks[event] = kept;
    }
    if (Object.keys(hooks).length === 0)
        delete settings.hooks;
    else
        settings.hooks = hooks;
    return { settings, removed };
}
