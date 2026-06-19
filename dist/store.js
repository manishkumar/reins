"use strict";
// Storage driver abstraction so reins works across Node versions.
//
// The live reflexes (guard, steer) never touch storage — they work on any Node.
// Capture + loop alarm need a synchronous SQLite. We try, in order:
//   1. node:sqlite        — built in on Node >= 22.5, zero deps (preferred)
//   2. better-sqlite3      — only if the user installed it (opt-in for old Node)
//   3. none                — capture silently disabled; guard/steer still work
//
// Both drivers expose a compatible synchronous API (exec + prepare→run/get/all),
// so a thin adapter is all that's needed.
Object.defineProperty(exports, "__esModule", { value: true });
exports.getDriver = getDriver;
exports.capabilityNote = capabilityNote;
let _resolved = false;
let _driver = null;
function getDriver() {
    if (_resolved)
        return _driver;
    _resolved = true;
    // Opt-out: lets privacy-minded users disable the trajectory log entirely while
    // keeping the live reflexes. Also the seam used to test the no-backend path.
    if (process.env.REINS_NO_SQLITE) {
        _driver = null;
        return _driver;
    }
    _driver = tryNodeSqlite() ?? tryBetterSqlite3() ?? null;
    return _driver;
}
/** Human-readable note about why capture is unavailable, for CLI messaging. */
function capabilityNote() {
    if (getDriver())
        return "";
    if (process.env.REINS_NO_SQLITE) {
        return "capture is OFF (REINS_NO_SQLITE is set). Steering and guards still work.";
    }
    const v = process.versions.node;
    return (`capture is disabled: no SQLite backend on this Node (${v}). ` +
        `Upgrade to Node >= 22.5 for the built-in driver, or run ` +
        `\`npm i -g better-sqlite3\`. Steering and guards work regardless.`);
}
function tryNodeSqlite() {
    // node:sqlite is experimental and emits a process warning on first load. Hooks
    // must keep stderr clean (it surfaces to the user/agent), so suppress that one.
    const origEmit = process.emitWarning.bind(process);
    process.emitWarning =
        ((warning, ...rest) => {
            const type = typeof rest[0] === "string"
                ? rest[0]
                : rest[0]?.type;
            if (type === "ExperimentalWarning" && String(warning).includes("SQLite"))
                return;
            return origEmit(warning, ...rest);
        });
    try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const mod = require("node:sqlite");
        if (!mod || typeof mod.DatabaseSync !== "function")
            return null;
        return {
            name: "node:sqlite",
            open(path, opts) {
                return new mod.DatabaseSync(path, { readOnly: opts?.readOnly });
            },
        };
    }
    catch {
        return null;
    }
}
function tryBetterSqlite3() {
    try {
        // Only present if the user installed it. Not a declared dependency.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const Database = require("better-sqlite3");
        return {
            name: "better-sqlite3",
            open(path, opts) {
                return new Database(path, { readonly: opts?.readOnly });
            },
        };
    }
    catch {
        return null;
    }
}
