"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.cmdName = cmdName;
const db_1 = require("../db");
const names_1 = require("../names");
const store_1 = require("../store");
const format_1 = require("./format");
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
function cmdName(args) {
    const db = (0, db_1.openDb)();
    if (!db) {
        console.log(format_1.c.dim((0, store_1.capabilityNote)() ||
            "Names live in .reins/runs.db, which needs a SQLite backend (Node ≥ 22.5). " +
                "Auto mnemonics still appear everywhere."));
        return 1;
    }
    if (!(0, db_1.hasSessionNameColumn)(db)) {
        console.error(format_1.c.red("This runs.db couldn't grow a name column; auto mnemonics still work."));
        return 1;
    }
    if (args.length === 0)
        return listNames(db);
    const token = args[0];
    const ids = (0, db_1.matchSessions)(db, token);
    if (ids.length === 0) {
        console.error(format_1.c.red(`No session matching "${token}" (see \`reins sessions\`).`));
        return 1;
    }
    if (ids.length > 1) {
        console.error(format_1.c.red(`"${token}" is ambiguous — it matches ${ids.length} sessions:`));
        for (const id of ids.slice(0, 5))
            console.error(`  ${short(id)}  ${format_1.c.dim((0, names_1.mnemonic)(id))}`);
        return 1;
    }
    const id = ids[0];
    if (args[1] === "--clear") {
        (0, db_1.setSessionName)(db, id, null);
        console.log(format_1.c.green("✓") + ` ${short(id)} is back to its auto name, ${format_1.c.cyan((0, names_1.mnemonic)(id))}.`);
        return 0;
    }
    const label = sanitizeLabel(args.slice(1).join(" "));
    if (!label) {
        // No label: show what this session is currently called.
        const row = (0, db_1.listSessionIds)(db).find((r) => r.id === id);
        const custom = row?.name?.trim();
        console.log(`${short(id)} is ${format_1.c.cyan((0, names_1.displayName)(id, custom))}` +
            (custom ? format_1.c.dim(` (custom — auto name: ${(0, names_1.mnemonic)(id)})`) : format_1.c.dim(" (auto name)")));
        console.log(format_1.c.dim(`Name it:  reins name ${short(id)} "<label>"`));
        return 0;
    }
    (0, db_1.setSessionName)(db, id, label);
    console.log(format_1.c.green("✓") + ` ${short(id)} is now ${format_1.c.cyan(label)}.`);
    console.log(format_1.c.dim(`Shows in sessions/watch; works as a target: reins steer --session ${label} "..."`));
    return 0;
}
function listNames(db) {
    const rows = (0, db_1.listSessionIds)(db, 15);
    if (rows.length === 0) {
        console.log(format_1.c.dim("No sessions recorded yet."));
        return 0;
    }
    console.log(format_1.c.bold("Recent sessions") + format_1.c.dim(" (custom names in cyan, auto mnemonics dimmed)"));
    console.log("");
    for (const r of rows) {
        const custom = r.name?.trim();
        const label = custom ? format_1.c.cyan(pad(custom, 18)) : format_1.c.dim(pad((0, names_1.mnemonic)(r.id), 18));
        console.log(`  ${label} ${short(r.id)}`);
    }
    console.log("");
    console.log(format_1.c.dim('Set one:  reins name <session> "<label>"   ·   back to auto: --clear'));
    return 0;
}
/** One line, modest length — a name is a handle, not a description. */
function sanitizeLabel(raw) {
    return raw.replace(/\s+/g, " ").trim().slice(0, 40);
}
function pad(s, width) {
    return s.length >= width ? s : s + " ".repeat(width - s.length);
}
function short(id) {
    return id.length > 8 ? id.slice(0, 8) : id;
}
