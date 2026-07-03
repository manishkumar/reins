// Helpers that emit decisions back to Claude Code over stdout, per the verified
// hook contract (Claude Code 2.1.x). Each hook invocation emits AT MOST one
// JSON object and exits 0. No output = passthrough/allow.

export function emitDeny(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    }),
  );
}

/** Explicitly allow, bypassing Claude Code's own permission prompt for this
 *  call. Only used when a human already signed off out-of-band — i.e. a
 *  one-shot `reins approve` allowance for this exact input. Asking again in
 *  the TUI would double-charge the human for the same decision. */
export function emitAllow(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "allow",
        permissionDecisionReason: reason,
      },
    }),
  );
}

/** Escalate to the human: Claude Code shows its native permission prompt with
 *  our reason. In non-interactive runs there is no prompt, so this denies. */
export function emitAsk(reason: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason: reason,
      },
    }),
  );
}

export function emitPreToolContext(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        additionalContext,
      },
    }),
  );
}

export function emitPostToolContext(additionalContext: string): void {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "PostToolUse",
        additionalContext,
      },
    }),
  );
}

/** Passthrough: allow the tool, inject nothing. */
export function emitNothing(): void {
  // Intentionally no stdout.
}
