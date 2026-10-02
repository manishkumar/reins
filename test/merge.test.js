const { test } = require("node:test");
const assert = require("node:assert");

const { mergeReinsHooks, unmergeReinsHooks } = require("../dist/settingsMerge.js");

test("mergeReinsHooks: adds every hook to empty settings", () => {
  const { settings, added } = mergeReinsHooks({});
  assert.strictEqual(added, 4);
  assert.strictEqual(settings.hooks.PostToolUseFailure[0].hooks[0].command, "reins hook post-tool-failure");
  assert.ok(settings.hooks.PreToolUse[0].hooks[0].command.includes("reins hook pre-tool"));
  assert.ok(settings.hooks.PostToolUse[0].hooks[0].command.includes("reins hook post-tool"));
  assert.ok(settings.hooks.Stop[0].hooks[0].command.includes("reins hook stop"));
});

test("mergeReinsHooks: idempotent — second merge adds nothing", () => {
  const first = mergeReinsHooks({});
  const second = mergeReinsHooks(first.settings);
  assert.strictEqual(second.added, 0);
  // and no duplicate entries crept in
  assert.strictEqual(second.settings.hooks.PreToolUse.length, 1);
});

test("mergeReinsHooks: preserves unrelated settings and existing hooks", () => {
  const input = {
    model: "claude-opus-4-8",
    permissions: { allow: ["Bash(ls)"] },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "my-other-hook" }] },
      ],
    },
  };
  const { settings, added } = mergeReinsHooks(input);
  assert.strictEqual(added, 4);
  assert.strictEqual(settings.model, "claude-opus-4-8");
  assert.deepStrictEqual(settings.permissions, { allow: ["Bash(ls)"] });
  // existing user hook is kept, reins hook appended
  assert.strictEqual(settings.hooks.PreToolUse.length, 2);
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, "my-other-hook");
});

test("mergeReinsHooks: null/undefined input is safe", () => {
  assert.strictEqual(mergeReinsHooks(null).added, 4);
  assert.strictEqual(mergeReinsHooks(undefined).added, 4);
});

test("mergeReinsHooks: does not mutate the input object", () => {
  const input = { hooks: {} };
  mergeReinsHooks(input);
  assert.deepStrictEqual(input, { hooks: {} });
});

test("unmergeReinsHooks: round-trips merge back to clean state", () => {
  const { settings } = mergeReinsHooks({ model: "x" });
  const { settings: cleaned, removed } = unmergeReinsHooks(settings);
  assert.strictEqual(removed, 4);
  assert.strictEqual(cleaned.model, "x");
  assert.strictEqual(cleaned.hooks, undefined); // pruned empty
});

test("unmergeReinsHooks: keeps the user's own hooks, removes only reins", () => {
  const input = {
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [{ type: "command", command: "my-hook" }] },
        { matcher: "*", hooks: [{ type: "command", command: "reins hook pre-tool" }] },
      ],
    },
  };
  const { settings, removed } = unmergeReinsHooks(input);
  assert.strictEqual(removed, 1);
  assert.strictEqual(settings.hooks.PreToolUse.length, 1);
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, "my-hook");
});

test("mergeReinsHooks: an install from before PostToolUseFailure gains just that hook", () => {
  const old = {
    hooks: {
      PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "reins hook pre-tool" }] }],
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "reins hook post-tool" }] }],
      Stop: [{ hooks: [{ type: "command", command: "reins hook stop" }] }],
    },
  };
  const { settings, added } = mergeReinsHooks(old);
  assert.strictEqual(added, 1);
  assert.strictEqual(settings.hooks.PostToolUse.length, 1, "the existing post-tool entry is not duplicated");
  assert.strictEqual(settings.hooks.PostToolUseFailure[0].hooks[0].command, "reins hook post-tool-failure");
});
