"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SETTINGS_BLOCK = void 0;
exports.settingsBlockJson = settingsBlockJson;
// The copy-pasteable Claude Code hooks block. `reins` must be resolvable on
// PATH (npm i -g reins). Swap `reins` for `npx reins` if you prefer no global
// install — but note npx adds cold-start latency on every tool call.
exports.SETTINGS_BLOCK = {
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
        // Claude Code sends a tool call that FAILED here and not to PostToolUse.
        // Without this entry a failing command is never captured: no failed test
        // run in the trajectory, and no loop alarm for a command failing on repeat.
        PostToolUseFailure: [
            {
                matcher: "*",
                hooks: [{ type: "command", command: "reins hook post-tool-failure" }],
            },
        ],
        Stop: [
            {
                hooks: [{ type: "command", command: "reins hook stop" }],
            },
        ],
    },
};
/** The block as text. `without` names events to leave out (see src/claudeVersion.ts). */
function settingsBlockJson(without = []) {
    const hooks = Object.fromEntries(Object.entries(exports.SETTINGS_BLOCK.hooks).filter(([event]) => !without.includes(event)));
    return JSON.stringify({ hooks }, null, 2);
}
