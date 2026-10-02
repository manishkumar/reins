# Open questions

Decisions this run did not make. No phase was stopped for one: nothing built
here changes what a hold or a guard does. Each item below needs a person.

## 1. Should capture keep more of a command than 160 characters on one line?

The claim check and the footprint read the captured `input_summary`: the
first 160 characters with newlines collapsed. Two effects:

- A long command ends in `…`, so a pipe after the cut is invisible. The claim
  check reports such a test run as "result not visible", never as a pass.
- A heredoc body is flattened into the command line. The parser strips it, but
  it is working from damaged text.

Storing the whole command would fix both. It would also put more of what
agents type into `.reins/runs.db`, including secrets passed on a command line.
That is a privacy decision about a file on the user's disk.

## 2. Is "result not visible" too common to be useful?

Agents pipe test output through `tail` or `grep` by habit. Without `pipefail`
the exit status is the last command's, so reins cannot tell pass from fail. In
this repository's own captured sessions that was the most common verdict. It
is left out of the Stop line for that reason and shown everywhere else.

Options: leave it; read the test runner's summary line from the tool response
(the hook receives it, capture does not store it); or steer agents towards
`set -o pipefail`. The second means parsing output formats, which is a larger
commitment than matching command names.

## 3. What does an older Claude Code do with the `PostToolUseFailure` key?

`reins init` now writes a fourth hook, `PostToolUseFailure`. On 2.1.287 it
works: a failing command is captured with `ok = 0`. Whether a Claude Code
version from before that event existed ignores the unknown key or rejects the
settings file was not tested. No older version was available here. If it
rejects, `reins init` on an old Claude Code would break that user's settings,
and init would need a version check.

## 4. Should failed calls feed the loop alarm and breach detection by default?

Before this run, a failing call never reached reins, so a command that failed
three times in a row raised no loop alarm and a held action that ran and
failed raised no HOLD BREACH. Both now fire. That is the documented behaviour,
newly true. It also means existing installs will see alarms they did not see
before, after `reins init` adds the hook. Whether that needs a release note
beyond the changelog entry is a call for whoever cuts the release.

## 5. Listing a looping session first changes the order of `reins watch`

The agent list was newest first. A looping session now leads it, then
sessions with a held action, and sessions quiet for over a day are counted in
the footer and not listed. The cursor
follows a row by id, so a selection does not jump to another session, but the
row itself moves when a session starts or stops looping. If a stable order
matters more than seeing the loop on a short terminal, the alternative is to
keep the order and name what is hidden in the list's footer.

## 6. Should `reins init` install the mod by default?

Decided so far: the mod ships in the npm package, `reins init --mod` copies it
into `.claude/skills/reins-status/`, and it finds `.reins/` by walking up with
`$.fs.stat`. Open: whether plain `reins init` should install it. Against: the
mod API is early access, `.claude/skills/` is usually committed so the mod
reaches the whole team, and the copy goes stale when reins is upgraded
(`reins doctor` does not yet report that). The status line, the band and the `/reins` pane have been
seen in a live interactive session; the toast has not. Also open:
whether the pane should open on its own when a hold parks. It does not, because
outside the fullscreen layout a pane sits above the prompt.

## 7. Should reins say when a mod is installed above it?

A mod's `tool.call` hook runs before reins and can rewrite a call or answer
it, and reins cannot see that (README, threat model). `reins doctor` could
list the mods that hook `tool.call`, by reading Claude Code's plugin folders.
That means reading another program's private layout, and the session title
reader already depends on one undocumented format. It would report only. It
is not built.
