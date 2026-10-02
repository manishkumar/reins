import { SETTINGS_BLOCK } from "./settingsBlock";

interface HookCmd {
  type: string;
  command: string;
}
interface HookEntry {
  matcher?: string;
  hooks: HookCmd[];
}

export interface MergeOutcome {
  /** The settings object with reins hooks ensured present. */
  settings: Record<string, unknown>;
  /** How many hook entries were newly added (0 = already wired). */
  added: number;
  /** How many reins entries were taken out because their event is in `without`. */
  removed: number;
}

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
export function mergeReinsHooks(
  input: Record<string, unknown> | null | undefined,
  without: string[] = [],
  /** False leaves an existing entry for a `without` event alone: the version is unknown, so nothing is known to be wrong with it. */
  strip = true,
): MergeOutcome {
  const settings: Record<string, unknown> = { ...(input ?? {}) };
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  let added = 0;
  let removed = 0;

  for (const event of strip ? without : []) {
    if (!Array.isArray(hooks[event])) continue;
    const kept = hooks[event].filter((e) => !(e.hooks ?? []).some((h) => (h.command ?? "").includes("reins hook")));
    removed += hooks[event].length - kept.length;
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  for (const [event, desired] of Object.entries(SETTINGS_BLOCK.hooks)) {
    if (without.includes(event)) continue;
    const existing = Array.isArray(hooks[event]) ? [...hooks[event]] : [];
    for (const wantEntry of desired as HookEntry[]) {
      const wantCmd = wantEntry.hooks[0].command;
      const present = existing.some((e) =>
        (e.hooks ?? []).some((h) => h.command === wantCmd),
      );
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

export interface UnmergeOutcome {
  settings: Record<string, unknown>;
  /** How many reins hook entries were removed. */
  removed: number;
}

/**
 * Remove reins hook entries from a parsed settings object, leaving any other
 * hooks (and all other keys) intact. Empty hook arrays/objects are pruned so
 * the file stays tidy. Pure function — easy to test.
 */
export function unmergeReinsHooks(input: Record<string, unknown> | null | undefined): UnmergeOutcome {
  const settings: Record<string, unknown> = { ...(input ?? {}) };
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  let removed = 0;

  for (const event of Object.keys(hooks)) {
    const entries = Array.isArray(hooks[event]) ? hooks[event] : [];
    const kept = entries.filter((e) => {
      const isReins = (e.hooks ?? []).some((h) => (h.command ?? "").includes("reins hook"));
      if (isReins) removed++;
      return !isReins;
    });
    if (kept.length === 0) delete hooks[event];
    else hooks[event] = kept;
  }

  if (Object.keys(hooks).length === 0) delete settings.hooks;
  else settings.hooks = hooks;
  return { settings, removed };
}
