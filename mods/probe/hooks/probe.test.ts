import { expect, test } from 'claude-code/testing'

// The test host has no real clock noun, so the probes spend real time by
// spinning. Run with: claude plugin test mods/probe
declare const setTimeout: (fn: () => void, ms: number) => unknown

const ran = { result: { stdout: 'ran', stderr: '' } } as never

test('order: the mod sees the call before a settings PreToolUse hook does', async ($, on) => {
  const seen: string[] = []
  on('classic.PreToolUse', ($, e, next) => {
    seen.push(`PreToolUse:${JSON.stringify(e)}`)

    return next(e)
  })
  on('tool.call', { tool: 'Bash' }, ($, e) => {
    seen.push(`core:${e.command}`)

    return ran
  })
  await $.tool.call({ tool: 'Bash', command: 'echo probe:rewrite' })
  expect(seen.length).toBe(2)
  expect(seen[0]).toContain('PreToolUse:')
  expect(seen[0]).toContain('[seen by mod]')
  expect(seen[1]).toBe('core:echo probe:rewrite [seen by mod]')
})

test('order: a PreToolUse deny reaches the mod as an errored result', async ($, on) => {
  let coreRan = false
  on('classic.PreToolUse', () => ({ deny: 'reins: held' }) as never)
  on('tool.call', { tool: 'Bash' }, () => {
    coreRan = true

    return ran
  })
  const out = await $.tool.call({ tool: 'Bash', command: 'echo probe:rewrite' })
  expect(coreRan).toBe(false)
  expect(JSON.stringify(out)).toContain('reins: held')
})

test('crash: a hook that throws is skipped and the call runs', async ($, on) => {
  let coreRan = false
  on('tool.call', { tool: 'Bash' }, () => {
    coreRan = true

    return ran
  })
  const out = await $.tool.call({ tool: 'Bash', command: 'echo probe:throw' })
  expect(coreRan).toBe(true)
  expect(out.deny).toBeUndefined()
})

test('timeout: a hook that waits 10.5s is skipped at 10s and the call runs', { timeoutMs: 30000 }, async ($, on) => {
  let coreRan = false
  on('tool.call', { tool: 'Bash' }, () => {
    coreRan = true

    return ran
  })
  const before = Date.now()
  const out = await $.tool.call({ tool: 'Bash', command: 'echo probe:wait=10500' })
  const took = Date.now() - before
  expect(coreRan).toBe(true)
  expect(out.deny).toBeUndefined()
  expect(took >= 9900 && took < 10400).toBe(true)
})

test('timeout: a hook that blocks the event loop for 10.5s is not cut off', { timeoutMs: 30000 }, async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ran)
  const out = await $.tool.call({ tool: 'Bash', command: 'echo probe:spin=10500' })
  expect(out.deny).toBe('probe: held after spinning')
})

test('timeout: a hook that spends 3s of its own time still answers', { timeoutMs: 30000 }, async ($, on) => {
  on('tool.call', { tool: 'Bash' }, () => ran)
  const out = await $.tool.call({ tool: 'Bash', command: 'echo probe:spin=3000' })
  expect(out.deny).toBe('probe: held after spinning')
})

test('timeout: a catch handler can answer for the hook that timed out', { timeoutMs: 30000 }, async ($, on) => {
  let coreRan = false
  on('tool.call', { tool: 'Read' }, () => {
    coreRan = true

    return { result: {} } as never
  })
  const out = await $.tool.call({ tool: 'Read', file_path: 'a.md' })
  expect(out.deny).toBe('probe: the catch handler answered')
  expect(coreRan).toBe(false)
})

test('dialog: 6s of waiting plus 6s in the ask dialog does not exhaust the 10s budget', { timeoutMs: 30000 }, async ($, on) => {
  let coreRan = false
  on('tool.call', { tool: 'AskUserQuestion' }, async () => {
    // the person reading the dialog
    await new Promise<void>(done => setTimeout(() => done(), 6000))

    return { result: { answers: { 'Approve this call?': 'Deny' } } } as never
  })
  on('tool.call', { tool: 'Bash' }, () => {
    coreRan = true

    return ran
  })
  const out = await $.tool.call({ tool: 'Bash', command: 'echo probe:ask' })
  expect(String(out.deny)).toContain('probe: dialog answered')
  expect(coreRan).toBe(false)
})
