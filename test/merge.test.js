const { test } = require("node:test");
const assert = require("node:assert");

const { mergeReinsHooks } = require("../dist/settingsMerge.js");

test("mergeReinsHooks: adds all three hooks to empty settings", () => {
  const { settings, added } = mergeReinsHooks({});
  assert.strictEqual(added, 3);
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
  assert.strictEqual(added, 3);
  assert.strictEqual(settings.model, "claude-opus-4-8");
  assert.deepStrictEqual(settings.permissions, { allow: ["Bash(ls)"] });
  // existing user hook is kept, reins hook appended
  assert.strictEqual(settings.hooks.PreToolUse.length, 2);
  assert.strictEqual(settings.hooks.PreToolUse[0].hooks[0].command, "my-other-hook");
});

test("mergeReinsHooks: null/undefined input is safe", () => {
  assert.strictEqual(mergeReinsHooks(null).added, 3);
  assert.strictEqual(mergeReinsHooks(undefined).added, 3);
});

test("mergeReinsHooks: does not mutate the input object", () => {
  const input = { hooks: {} };
  mergeReinsHooks(input);
  assert.deepStrictEqual(input, { hooks: {} });
});
