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
const GATE_ROW = /^(DENIED|ASKED|HELD|APPROVED|REFUSED): /;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
/** Prose is not what a test run verifies; editing it alone is not an unverified change. */
const DOC_FILE = /\.(md|mdx|markdown|txt|rst|adoc)$/i;
/** Words allowed in front of the command itself. */
const PREFIX = /^(?:(?:[A-Za-z_][A-Za-z0-9_]*=\S*|time|command|exec|sudo|npx|bunx|pnpx|pnpm\s+exec|pnpm\s+dlx|yarn\s+dlx|bundle\s+exec|poetry\s+run|uv\s+run|pipenv\s+run)\s+)*/;
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
function verificationIn(command) {
    // A heredoc body is data, not commands.
    const cut = command.indexOf("<<");
    const head = cut >= 0 ? command.slice(0, cut) : command;
    const kinds = new Set();
    let visible = !command.endsWith("…");
    const pipefail = /\bpipefail\b/.test(head);
    for (const pipeline of head.split(/&&|\|\||;/)) {
        const stages = pipeline.split("|");
        const first = stages[0].trim().replace(PREFIX, "");
        const kind = TEST_CMDS.some((re) => re.test(first)) ? "test" : BUILD_CMDS.some((re) => re.test(first)) ? "build" : null;
        if (!kind)
            continue;
        kinds.add(kind);
        if (stages.length > 1 && !pipefail)
            visible = false;
    }
    return kinds.size ? { kinds: [...kinds], visible } : null;
}
function checkClaim(calls) {
    const last = {};
    const edits = [];
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
        if (!v)
            return;
        const outcome = c.ok === null || !v.visible ? "unknown" : c.ok === 0 ? "fail" : "pass";
        for (const kind of v.kinds)
            last[kind] = { kind, outcome, command: c.summary, at };
    });
    const edited = new Set(edits.map((e) => e.file)).size;
    const runs = [last.test, last.build].filter((r) => !!r);
    if (!runs.length) {
        return edited
            ? { verdict: "unverified", text: `${files(edited)} edited, no test or build run`, command: null, edited, editedSince: edited }
            : { verdict: "none", text: "", command: null, edited, editedSince: 0 };
    }
    const latest = runs.reduce((a, b) => (b.at > a.at ? b : a));
    const editedSince = new Set(edits.filter((e) => e.at > latest.at).map((e) => e.file)).size;
    const base = { edited, editedSince };
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
        text: tests ? `tests passed${after}` : `the build passed${after}; no test run${after}`,
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
