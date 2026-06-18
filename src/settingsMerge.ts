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
}

/**
 * Idempotently ensure reins hook entries exist in a parsed Claude Code settings
 * object. Pure function (no IO) so it's easy to test. Preserves all existing
 * keys and any unrelated hooks the user already has.
 */
export function mergeReinsHooks(input: Record<string, unknown> | null | undefined): MergeOutcome {
  const settings: Record<string, unknown> = { ...(input ?? {}) };
  const hooks = { ...((settings.hooks as Record<string, HookEntry[]>) ?? {}) };
  let added = 0;

  for (const [event, desired] of Object.entries(SETTINGS_BLOCK.hooks)) {
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
  return { settings, added };
}
