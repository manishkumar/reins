"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.FAILURE_HOOK = exports.FAILURE_HOOK_SINCE = void 0;
exports.claudeCodeVersion = claudeCodeVersion;
exports.parseVersion = parseVersion;
exports.olderThan = olderThan;
exports.predatesFailureHook = predatesFailureHook;
const node_child_process_1 = require("node:child_process");
/**
 * Which Claude Code is installed, for `reins init` and `reins doctor`.
 *
 * It matters because of one measured fact: Claude Code 2.0.55 and older load NO
 * hooks from a settings file that names an event they do not know. reins
 * writes `PostToolUseFailure`, which arrived in 2.0.56. On an older Claude
 * Code that one key turns off every guard, hold and steer in the file, with no
 * error. Measured by running 2.0.0, 2.0.55 and 2.0.56 against the same
 * settings file (docs/open-questions.md, item 3).
 *
 * Never called from `reins hook *`: a hook that is not loaded cannot check
 * anything, and one that is loaded has no need to.
 */
/** The first Claude Code that knows the `PostToolUseFailure` event. */
exports.FAILURE_HOOK_SINCE = "2.0.56";
exports.FAILURE_HOOK = "PostToolUseFailure";
/** `claude --version` as "2.1.287", or null when it cannot be run or read. */
function claudeCodeVersion() {
    // Tests, and a person whose `claude` is not on PATH, can say it outright.
    const stated = process.env.REINS_CLAUDE_VERSION;
    if (stated !== undefined)
        return parseVersion(stated);
    try {
        const out = (0, node_child_process_1.execFileSync)("claude", ["--version"], { encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "ignore"] });
        return parseVersion(out);
    }
    catch {
        return null;
    }
}
function parseVersion(text) {
    const m = /(\d+)\.(\d+)\.(\d+)/.exec(text);
    return m ? `${Number(m[1])}.${Number(m[2])}.${Number(m[3])}` : null;
}
function olderThan(version, than) {
    const a = version.split(".").map(Number);
    const b = than.split(".").map(Number);
    for (let i = 0; i < 3; i++) {
        if ((a[i] ?? 0) !== (b[i] ?? 0))
            return (a[i] ?? 0) < (b[i] ?? 0);
    }
    return false;
}
/**
 * True only when the installed Claude Code is known to predate the failure
 * hook. An unknown version is treated as current: most installs are, and
 * leaving the hook out there would lose failed-call capture for everyone
 * whose `claude` is not on PATH. `reins init` says so when it cannot tell.
 */
function predatesFailureHook(version) {
    return version !== null && olderThan(version, exports.FAILURE_HOOK_SINCE);
}
