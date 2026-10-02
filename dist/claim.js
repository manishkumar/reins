"use strict";
/**
 * The claim check: when a session says it is done, what do its own tool calls
 * say?
 *
 * An agent that edited five files and never ran a test will still write
 * "all tests pass". The trajectory is the evidence, and this reads it: the
 * last test or build run failed, files were edited after the last run, or
 * nothing was run at all.
 *
 * It reports and stops there (the same rule as bypass detection). No verdict
 * blocks a stop, changes a guard or hold decision, or is read by one. It is
 * deterministic: command text and exit status only, no model, no network.
 *
 * Precision over recall. A command counts as a test or build run only when it
 * stands at command position, and a result reins cannot see is reported as
 * unknown, not as a pass:
 *   - `npm test | tail` exits with tail's status, so its result is unknown
 *     (unless the command sets pipefail);
 *   - `npm test || true`, `npm test; echo done` and `npm test &` report
 *     another command's status or none, so their result is unknown too
 *     (`|| exit 1` keeps the failure, and so does `set -e` before a `;`);
 *   - an interrupted run, and a command too long for the captured summary to
 *     show whole, are unknown too.
 * What it cannot see at all: edits made through the shell (sed -i, a script),
 * and checks run outside the session.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.verificationIn = verificationIn;
exports.checkClaim = checkClaim;
exports.claimNeedsAttention = claimNeedsAttention;
exports.touchesClaim = touchesClaim;
const shell_1 = require("./shell");
const GATE_ROW = /^(DENIED|ASKED|HELD|APPROVED|REFUSED): /;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Prose is not what a test run verifies; editing it alone is not an unverified change. */
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
const TEST_CMDS = [
    /^(npm|pnpm|yarn|bun)\s+(run\s+)?(test|t)(:[\w:.-]+)?(\s|$)/,
    /^(jest|vitest|mocha|ava|pytest|tox|nox|rspec|phpunit|ctest)(\s|$)/,
    /^playwright\s+test(\s|$)/,
    /^cypress\s+run(\s|$)/,
    /^node\s+(\S+\s+)*--test(\s|=|$)/,
    /^(python[\d.]*|py)\s+-m\s+(pytest|unittest)(\s|$)/,
    /^(go|cargo|dotnet|deno|swift|mix|zig)\s+test(\s|$)/,
    /^cargo\s+nextest(\s|$)/,
    /^(rake|rails)\s+test(\s|$)/,
    /^make\s+(\S+\s+)*(test|check)(\s|$)/,
    /^(mvn|\.\/mvnw|gradle|\.\/gradlew)\s+(\S+\s+)*(test|check|verify)(\s|$)/,
];
const BUILD_CMDS = [
    /^(npm|pnpm|yarn|bun)\s+run\s+(build|lint|typecheck|type-check|check|compile)(:[\w:.-]+)?(\s|$)/,
    /^(pnpm|yarn|bun)\s+(build|lint|typecheck)(\s|$)/,
    /^(tsc|eslint|mypy|pyright|clippy)(\s|$)/,
    /^ruff\s+check(\s|$)/,
    /^cargo\s+(build|check|clippy)(\s|$)/,
    /^go\s+(build|vet)(\s|$)/,
    /^dotnet\s+build(\s|$)/,
    /^make(\s+(build|all))?\s*$/,
    /^(mvn|\.\/mvnw)\s+(\S+\s+)*(compile|package)(\s|$)/,
    /^(gradle|\.\/gradlew)\s+(\S+\s+)*(build|assemble)(\s|$)/,
];
/**
 * Which kinds of check a shell command runs, and whether its exit status can
 * be trusted to be theirs. Null when it runs none.
 */
function kindOf(words) {
    // `./node_modules/.bin/jest` is jest. `./gradlew` and `./mvnw` are matched as written.
    const bare = [words[0].replace(/^.*\//, ""), ...words.slice(1)].join(" ");
    for (const text of [words.join(" "), bare]) {
        if (TEST_CMDS.some((re) => re.test(text)))
            return "test";
        if (BUILD_CMDS.some((re) => re.test(text)))
            return "build";
    }
    return null;
}
/** After `||`, a command that still ends the call with a failure: `exit 1`, `return 1`, `false`. */
function keepsFailure(words) {
    if (words[0] === "false")
        return true;
    return (words[0] === "exit" || words[0] === "return") && words[1] !== "0";
}
function verificationIn(command) {
    const kinds = new Set();
    // A summary cut short may hide a pipe.
    let visible = !command.endsWith("…");
    const pipefail = /\bpipefail\b/.test(command);
    const errexit = /(^|[\s;&])set\s+-[a-z]*e/.test(command);
    const cmds = (0, shell_1.shellCommands)(command);
    cmds.forEach((cmd, i) => {
        const kind = kindOf(cmd.words);
        if (!kind)
            return;
        kinds.add(kind);
        if (cmd.piped && !pipefail)
            visible = false;
        // The call's exit status is this command's only if nothing after it replaces it.
        const next = cmds[i + 1];
        if (cmd.then === "&")
            visible = false;
        if (cmd.then === ";" && !errexit)
            visible = false;
        if (cmd.then === "||" && !(next && keepsFailure(next.words)))
            visible = false;
    });
    return kinds.size ? { kinds: [...kinds], visible } : null;
}
function checkClaim(calls) {
    const last = {};
    const edits = [];
    const shellWrites = [];
    calls.forEach((c, at) => {
        if (GATE_ROW.test(c.summary))
            return; // a gate row is a decision, not an execution
        if (EDIT_TOOLS.has(c.tool)) {
            if (c.ok !== 0 && !DOC_FILE.test(c.summary))
                edits.push({ file: c.summary, at });
            return;
        }
        if (c.tool !== "Bash")
            return;
        const v = verificationIn(c.summary);
        if (!v) {
            if (c.ok !== 0 && (0, shell_1.mayWriteFiles)(c.summary))
                shellWrites.push(at);
            return;
        }
        const outcome = c.ok === null || !v.visible ? "unknown" : c.ok === 0 ? "fail" : "pass";
        for (const kind of v.kinds)
            last[kind] = { kind, outcome, command: c.summary, at };
    });
    const edited = new Set(edits.map((e) => e.file)).size;
    const runs = [last.test, last.build].filter((r) => !!r);
    if (!runs.length) {
        return edited
            ? { verdict: "unverified", text: `${files(edited)} edited, no test or build run`, command: null, edited, editedSince: edited, shellWritesSince: 0 }
            : { verdict: "none", text: "", command: null, edited, editedSince: 0, shellWritesSince: 0 };
    }
    const latest = runs.reduce((a, b) => (b.at > a.at ? b : a));
    const editedSince = new Set(edits.filter((e) => e.at > latest.at).map((e) => e.file)).size;
    const shellWritesSince = shellWrites.filter((at) => at > latest.at).length;
    const base = { edited, editedSince, shellWritesSince };
    // Files can change without an edit tool (a redirect, sed -i, a script). The
    // check cannot see those changes, so a pass says how many it did not see.
    const unseen = shellWritesSince
        ? `; ${shellWritesSince} shell command${shellWritesSince === 1 ? "" : "s"} after it may have changed files`
        : "";
    // The latest run of each kind is what stands. A failed test run is not
    // repaired by a later build that passed.
    const failed = runs.find((r) => r.outcome === "fail");
    if (failed) {
        const since = editedSince ? `, ${files(editedSince)} edited since` : "";
        return { ...base, verdict: "failed", text: `the last ${failed.kind} run failed${since}`, command: failed.command };
    }
    if (editedSince) {
        return { ...base, verdict: "stale", text: `${files(editedSince)} edited after the last ${latest.kind} run`, command: latest.command };
    }
    if (latest.outcome === "unknown") {
        return { ...base, verdict: "unknown", text: `the last ${latest.kind} run's result is not visible (piped, interrupted, or cut short)`, command: latest.command };
    }
    const lastEdit = edits.length ? edits[edits.length - 1].at : -1;
    const tests = last.test && last.test.outcome === "pass" && last.test.at > lastEdit;
    const after = edits.length ? " after the last edit" : "";
    return {
        ...base,
        verdict: "verified",
        text: (tests ? `tests passed${after}` : `the build passed${after}; no test run${after}`) + unseen,
        command: latest.command,
    };
}
function files(n) {
    return `${n} file${n === 1 ? "" : "s"}`;
}
/**
 * Verdicts worth interrupting someone for. "unknown" is not one: agents pipe
 * test output through tail or grep as a habit, and a line at every Stop saying
 * so would be turned off within a day. It still shows wherever the verdict is
 * displayed.
 */
function claimNeedsAttention(c) {
    return c.verdict === "failed" || c.verdict === "stale" || c.verdict === "unverified";
}
/** True for a call that can change a claim: an edit, or a test or build run. */
function touchesClaim(c) {
    if (GATE_ROW.test(c.summary))
        return false;
    if (EDIT_TOOLS.has(c.tool))
        return c.ok !== 0 && !DOC_FILE.test(c.summary);
    return c.tool === "Bash" && verificationIn(c.summary) !== null;
}
