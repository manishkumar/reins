"use strict";
// Helpers that emit decisions back to Claude Code over stdout, per the verified
// hook contract (Claude Code 2.1.x). Each hook invocation emits AT MOST one
// JSON object and exits 0. No output = passthrough/allow.
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitDeny = emitDeny;
exports.emitPreToolContext = emitPreToolContext;
exports.emitPostToolContext = emitPostToolContext;
exports.emitNothing = emitNothing;
function emitDeny(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: reason,
        },
    }));
}
function emitPreToolContext(additionalContext) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            additionalContext,
        },
    }));
}
function emitPostToolContext(additionalContext) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PostToolUse",
            additionalContext,
        },
    }));
}
/** Passthrough: allow the tool, inject nothing. */
function emitNothing() {
    // Intentionally no stdout.
}
