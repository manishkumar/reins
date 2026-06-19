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
        Stop: [
            {
                hooks: [{ type: "command", command: "reins hook stop" }],
            },
        ],
    },
};
function settingsBlockJson() {
    return JSON.stringify(exports.SETTINGS_BLOCK, null, 2);
}
