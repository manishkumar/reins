import {
  openDb,
  hasSessionNameColumn,
  matchSessions,
  setSessionName,
  listSessionIds,
} from "../db";
import { mnemonic, displayName } from "../names";
import { capabilityNote } from "../store";
import { c } from "./format";

/**
 * `reins name` — give a session a memorable label.
 *
 * Every session already has a free deterministic mnemonic (`brave-otter`,
 * derived from its id — see names.ts); this command is for the moment you've
 * identified WHAT a session is doing ("the auth refactor one") and want that
 * knowledge to stick. Names show up in `sessions`, `watch`, and the steer
 * picker, and work as `--session` targets.
 *
 * Names are display + addressing sugar stored in the capture DB. Steering
 * files, the hold queue, and allowances stay keyed by the real session id —
 * no control-plane decision ever depends on a name resolving.
 */
export function cmdName(args: string[]): number {
  const db = openDb();
  if (!db) {
    console.log(
      c.dim(
        capabilityNote() ||
          "Names live in .reins/runs.db, which needs a SQLite backend (Node ≥ 22.5). " +
            "Auto mnemonics still appear everywhere.",
      ),
    );
    return 1;
  }
  if (!hasSessionNameColumn(db)) {
    console.error(c.red("This runs.db couldn't grow a name column; auto mnemonics still work."));
    return 1;
  }

  if (args.length === 0) return listNames(db);

  const token = args[0];
  const ids = matchSessions(db, token);
  if (ids.length === 0) {
    console.error(c.red(`No session matching "${token}" (see \`reins sessions\`).`));
    return 1;
  }
  if (ids.length > 1) {
    console.error(c.red(`"${token}" is ambiguous — it matches ${ids.length} sessions:`));
    for (const id of ids.slice(0, 5)) console.error(`  ${short(id)}  ${c.dim(mnemonic(id))}`);
    return 1;
  }
  const id = ids[0];

  if (args[1] === "--clear") {
    setSessionName(db, id, null);
    console.log(c.green("✓") + ` ${short(id)} is back to its auto name, ${c.cyan(mnemonic(id))}.`);
    return 0;
  }

  const label = sanitizeLabel(args.slice(1).join(" "));
  if (!label) {
    // No label: show what this session is currently called.
    const row = listSessionIds(db).find((r) => r.id === id);
    const custom = row?.name?.trim();
    console.log(
      `${short(id)} is ${c.cyan(displayName(id, custom))}` +
        (custom ? c.dim(` (custom — auto name: ${mnemonic(id)})`) : c.dim(" (auto name)")),
    );
    console.log(c.dim(`Name it:  reins name ${short(id)} "<label>"`));
    return 0;
  }

  setSessionName(db, id, label);
  console.log(c.green("✓") + ` ${short(id)} is now ${c.cyan(label)}.`);
  console.log(c.dim(`Shows in sessions/watch; works as a target: reins steer --session ${label} "..."`));
  return 0;
}

function listNames(db: NonNullable<ReturnType<typeof openDb>>): number {
  const rows = listSessionIds(db, 15);
  if (rows.length === 0) {
    console.log(c.dim("No sessions recorded yet."));
    return 0;
  }
  console.log(c.bold("Recent sessions") + c.dim(" (custom names in cyan, auto mnemonics dimmed)"));
  console.log("");
  for (const r of rows) {
    const custom = r.name?.trim();
    const label = custom ? c.cyan(pad(custom, 18)) : c.dim(pad(mnemonic(r.id), 18));
    console.log(`  ${label} ${short(r.id)}`);
  }
  console.log("");
  console.log(c.dim('Set one:  reins name <session> "<label>"   ·   back to auto: --clear'));
  return 0;
}

/** One line, modest length — a name is a handle, not a description. */
function sanitizeLabel(raw: string): string {
  return raw.replace(/\s+/g, " ").trim().slice(0, 40);
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function short(id: string): string {
  return id.length > 8 ? id.slice(0, 8) : id;
}
