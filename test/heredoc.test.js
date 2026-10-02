// Run with: npm run build && npm test
// Heredoc bodies that are data are not matched by bash rules. Every doubt
// keeps the body in, so the guard fires more and never less.
const { test } = require("node:test");
const assert = require("node:assert");

const guards = require("../dist/guards.js");
const { whyMatched } = require("../dist/tui/why.js");

const PUSH = { id: "push", type: "bash", pattern: "git\\s+push\\b", reason: "r", action: "hold" };
const fires = (command) => guards.firingSegment(PUSH, command) !== null;

test("heredoc data: text handed to a known reader does not fire a rule", () => {
  for (const command of [
    "python3 - <<'EOF'\ns = 'then git push origin main'\nprint(s)\nEOF",
    "cd /repo && python3 - <<'PYEOF'\nimport io\n# git push is mentioned here\nPYEOF\nnpm run build",
    "cat > notes.md <<EOF\nRemember to git push when done\nEOF",
    "cat <<-EOF > notes.md\n\tgit push later\n\tEOF",
    'FOO=1 /usr/bin/node <<"JS"\nconsole.log("git push")\nJS',
    "tee -a log.txt <<'EOF'\ngit push happened\nEOF",
    // An apostrophe in the body no longer opens a quote that swallows what follows.
    "cat > a.txt <<'EOF'\ndon't git push yet\nEOF\necho done",
  ]) {
    assert.strictEqual(fires(command), false, command);
  }
});

test("heredoc data: commands around the heredoc still fire", () => {
  for (const command of [
    "cat > a.txt <<'EOF'\nhello\nEOF\ngit push origin main",
    "cat <<'EOF' > a.txt && git push\nhello\nEOF",
    "git push && cat <<'EOF'\nhello\nEOF",
    "cat > a.txt <<'EOF'\nit's here\nEOF\ngit push",
  ]) {
    assert.strictEqual(fires(command), true, command);
  }
});

test("heredoc data: a body something may run is still matched", () => {
  for (const command of [
    // A shell runs its body.
    "bash <<'EOF'\ngit push origin main\nEOF",
    "sh -s <<EOF\ngit push\nEOF",
    "ssh host <<'EOF'\ngit push\nEOF",
    "sudo tee /dev/null <<'EOF'\ngit push\nEOF",
    // The body is piped or substituted into something else.
    "cat <<'EOF' | sh\ngit push\nEOF",
    "eval $(cat <<'EOF'\ngit push\nEOF\n)",
    // An unquoted delimiter lets the shell run substitutions in the body.
    "cat <<EOF\n$(git push)\nEOF",
    "cat <<EOF\n`git push`\nEOF",
    // No closing delimiter: not a heredoc.
    "cat <<'EOF'\ngit push",
    "cat <<'EOF'\ngit push\n  EOF",
    // `<<` in a comment or inside a string is not a heredoc.
    "# cat <<'EOF'\ngit push\nEOF",
    "echo \"\ncat <<'EOF'\n\" ; git push ; echo \"\nEOF\n\"",
    "echo \"cat <<'EOF'\"\ngit push\nEOF",
    // A here-string is one line.
    "cat <<<EOF\ngit push\nEOF",
  ]) {
    assert.strictEqual(fires(command), true, command);
  }
});

test("heredoc data: other rules read a database client's heredoc", () => {
  const drop = { id: "sql", type: "bash", pattern: "drop\\s+table", reason: "r", action: "deny" };
  assert.ok(guards.firingSegment(drop, "psql mydb <<'EOF'\nDROP TABLE users;\nEOF"));
  assert.strictEqual(guards.firingSegment(drop, "cat > migration.sql <<'EOF'\nDROP TABLE users;\nEOF"), null);
});

test("heredoc data: checkGuards and the cockpit's match agree", () => {
  const g = { rules: [PUSH] };
  const data = "python3 - <<'EOF'\nprint('git push')\nEOF";
  assert.strictEqual(guards.checkGuards(g, "Bash", { command: data }), null);
  assert.strictEqual(whyMatched(PUSH, data), null);

  const real = "cat > a.txt <<'EOF'\nhello\nEOF\ngit push origin main";
  assert.ok(guards.checkGuards(g, "Bash", { command: real }));
  const span = whyMatched(PUSH, real);
  assert.strictEqual(real.slice(span.start, span.end), "git push");
  assert.strictEqual(span.line, 4);
});

test("dropHeredocData: a command without a heredoc is returned unchanged", () => {
  for (const command of ["git push", "echo $((1 << 3))", "python3 -c 'print(1<<3)'", "a\nb\nc"]) {
    assert.strictEqual(guards.dropHeredocData(command), command);
  }
});
