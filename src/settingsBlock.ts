// The copy-pasteable Claude Code hooks block. `reins` must be resolvable on
// PATH (npm i -g reins). Swap `reins` for `npx reins` if you prefer no global
// install — but note npx adds cold-start latency on every tool call.
export const SETTINGS_BLOCK = {
  hooks: {
    PreToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: "reins hook pre-tool" }],
      },
    ],
    PostToolUse: [
      {
        matcher: "*",
        hooks: [{ type: "command", command: "reins hook post-tool" }],
      },
    ],
    Stop: [
      {
        hooks: [{ type: "command", command: "reins hook stop" }],
      },
    ],
  },
};

export function settingsBlockJson(): string {
  return JSON.stringify(SETTINGS_BLOCK, null, 2);
}
