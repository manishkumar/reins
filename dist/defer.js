"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.canDefer = canDefer;
exports.isPrintMode = isPrintMode;
exports.isPrintModeArgv = isPrintModeArgv;
const node_child_process_1 = require("node:child_process");
const config_1 = require("./config");
/**
 * Whether Claude Code will actually honor a "defer" decision from this hook.
 *
 * Deferring parks the tool call itself: the turn ends with stop_reason
 * "tool_deferred", the unresolved call stays in the transcript, and resuming
 * the session replays that exact call through this hook again. It is a far
 * better hold than a deny — the approver signs off on the real call instead of
 * asking the agent to reconstruct it — but Claude Code honors it ONLY in print
 * mode. In an interactive session the decision is discarded ("defer is
 * print-mode only") and the call falls through to normal permission handling,
 * which under a permissive --permission-mode means it simply runs. A hold that
 * silently stopped holding is the worst bug this project can ship, so this
 * predicate demands POSITIVE EVIDENCE of print mode and answers "no" otherwise.
 *
 * How the evidence is obtained, and why not the obvious way: Claude Code
 * computes its own interactivity at startup from argv (-p / --print /
 * --init-only / --sdk-url*) or a non-TTY stdout, and keeps it in memory. It is
 * NOT passed to hooks — not in the event payload, not in the environment.
 * CLAUDE_CODE_ENTRYPOINT looks like a proxy for it and is not one: it is an
 * independently-settable telemetry label that a parent process can pre-set, so
 * a genuine `claude -p` run can report "claude-vscode" (verified), and an
 * interactive session that inherited the variable can report "sdk-cli". Both
 * directions are wrong, and one of them is wrong toward allowing.
 *
 * So instead we read the argv of the Claude Code process itself (CLAUDE_PID),
 * which is the same input Claude Code judged itself by. This costs one `ps`
 * call, paid ONLY when a hold rule has already matched — never on the hot path
 * of ordinary tool calls. Where it cannot be answered (no CLAUDE_PID, no ps,
 * Windows), the answer is "no" and the deny transport is used, which works
 * everywhere.
 *
 * KNOWN GAP (undetectable here, stated rather than papered over): Claude Code
 * also ignores defer when the model emitted several tool calls in one assistant
 * message ("defer is solo-only"), which nothing visible to a hook reveals. The
 * PostToolUse hook therefore reports any parked action that executed anyway as
 * a HOLD BREACH — detection where prevention isn't available.
 */
function canDefer(payload) {
    let mode;
    try {
        mode = (0, config_1.loadConfig)(payload?.cwd || undefined).holdTransport;
    }
    catch {
        mode = "auto";
    }
    if (mode === "deny")
        return false;
    if (mode === "defer")
        return true; // pinned by the user, evidence not consulted
    return isPrintMode();
}
/** Print-mode flags, per Claude Code's own startup check. */
const PRINT_FLAGS = ["-p", "--print", "--init-only"];
/**
 * Read the Claude Code process's own command line and judge it the way Claude
 * Code judges itself. Any failure answers "not print mode".
 */
function isPrintMode() {
    const pid = process.env.CLAUDE_PID;
    if (!pid || !/^\d+$/.test(pid))
        return false;
    if (process.platform === "win32")
        return false; // no ps; deny transport it is
    let argv;
    try {
        argv = (0, node_child_process_1.execFileSync)("ps", ["-o", "args=", "-p", pid], {
            encoding: "utf8",
            timeout: 2000,
            stdio: ["ignore", "pipe", "ignore"],
        });
    }
    catch {
        return false;
    }
    return isPrintModeArgv(argv);
}
/**
 * True if a Claude Code command line is a print-mode invocation.
 *
 * Only flags BEFORE the first non-flag argument count. `ps` returns one flat
 * string with quoting lost, so a prompt is indistinguishable from arguments —
 * and `claude "fix the --print bug"` starts an INTERACTIVE session whose prompt
 * merely contains a flag-looking word. Stopping at the first non-flag token
 * means such a prompt can never be mistaken for a print-mode flag. The cost is
 * false negatives (`claude --model sonnet -p "…"` stops at "sonnet"), which
 * fall back to the deny transport — the safe direction.
 *
 * Exported for tests: this is the whole judgment, worth pinning precisely.
 */
function isPrintModeArgv(argv) {
    const tokens = argv.trim().split(/\s+/);
    for (const tok of tokens.slice(1)) {
        if (!tok.startsWith("-"))
            return false; // reached the prompt/arguments
        if (PRINT_FLAGS.includes(tok) || tok.startsWith("--sdk-url"))
            return true;
    }
    return false;
}
