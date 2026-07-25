"use strict";
// Helpers that emit decisions back to Claude Code over stdout, per the verified
// hook contract (Claude Code 2.1.x). Each hook invocation emits AT MOST one
// JSON object and exits 0. No output = passthrough/allow.
Object.defineProperty(exports, "__esModule", { value: true });
exports.emitDeny = emitDeny;
exports.emitAllow = emitAllow;
exports.emitAsk = emitAsk;
exports.emitDefer = emitDefer;
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
/** Explicitly allow, bypassing Claude Code's own permission prompt for this
 *  call. Only used when a human already signed off out-of-band — i.e. a
 *  one-shot `reins approve` allowance for this exact input. Asking again in
 *  the TUI would double-charge the human for the same decision. */
function emitAllow(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "allow",
            permissionDecisionReason: reason,
        },
    }));
}
/** Escalate to the human: Claude Code shows its native permission prompt with
 *  our reason. In non-interactive runs there is no prompt, so this denies. */
function emitAsk(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "ask",
            permissionDecisionReason: reason,
        },
    }));
}
/** Park this exact tool call in Claude Code's own transcript ("defer"), instead
 *  of denying it. The turn ends with stop_reason "tool_deferred" and the call
 *  survives as an unresolved tool_use; resuming the session replays it through
 *  this hook again, so an approval can let the ORIGINAL call run rather than
 *  asking the agent to reconstruct it.
 *
 *  Only honored in print mode (`claude -p`) and only when the call is alone in
 *  its assistant message — Claude Code silently ignores defer otherwise, which
 *  is why the hold gate never emits this unless it can tell defer will stick.
 *  See canDefer() in src/defer.ts. */
function emitDefer(reason) {
    process.stdout.write(JSON.stringify({
        hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "defer",
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
