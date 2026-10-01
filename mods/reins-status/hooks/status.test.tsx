import { expect, mock, test } from 'claude-code/testing'

import { clean, parse } from './register'

// Run with: claude plugin test mods/reins-status
const hold = (id: string, command: string, ts: string) =>
  JSON.stringify({ id, session_id: 's1', tool: 'Bash', input: { command }, rule_id: 'push-hold', reason: 'r', transport: 'deny', ts })

const FILES: Record<string, string> = {
  'a1.json': hold('a1', 'git push origin main', '2026-10-01T10:00:02Z'),
  'b2.json': hold('b2', 'npm publish', '2026-10-01T10:00:01Z'),
  'c3.json': 'not json',
  'notes.txt': 'ignored',
}

const entry = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })

const START = { cwd: '/work/app', surface: 'terminal', isInteractive: true } as const
const BAND = { component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false } as never }

test('clean: escape sequences and control characters never reach the screen', () => {
  expect(clean('git push\x1b]52;c;ZXZpbA==\x07 \x1b[2J origin\nmain', 70)).toBe('git push origin main')
  expect(clean('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`)
  expect(parse('{"id":1}')).toBe(null)
  expect(parse(hold('a1', 'x\x1b[31my', '2026-10-01T10:00:02Z'))?.what).toBe('xy')
})

test('holds on disk become a status line and a band, oldest first', async ($, on) => {
  mock.clock(on)
  const status: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('fs.list', () => ({ value: Object.keys(FILES).map(entry) }))
  on('fs.read', (_, e) => ({ value: FILES[e.path.split('/').pop() ?? ''] ?? '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)

  await $.session.start(START)
  expect(status.at(-1)).toBe('reins: 2 held · reins pending')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'reins-status', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /reins: 2 held, waiting on you/ })).toBeDefined()
    const rows = await ui.findAll({ type: 'Text', text: /push-hold/ })
    expect(rows.length).toBe(2)
    expect(rows[0]?.text).toContain('b2 Bash [push-hold] npm publish')
    expect(await ui.find({ type: 'Text', text: /reins approve <id>/ })).toBeDefined()
    // A view only: nothing on it can be pressed.
    expect((await ui.findAll({ type: 'Button' })).length).toBe(0)
    await ui.unmount()
  }
})

test('no .reins directory: no status line, and the band passes', async ($, on) => {
  mock.clock(on)
  const status: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('fs.list', () => {
    throw new Error('ENOENT')
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)
  on('ui.render', { component: 'AbovePrompt' }, () => null as never)

  await $.session.start(START)
  expect(status.at(-1)).toBeUndefined()
})

test('a hold answered elsewhere leaves the band at the next refresh', async ($, on) => {
  const clock = mock.clock(on)
  let files = ['a1.json']
  const status: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  on('fs.list', () => ({ value: files.map(entry) }))
  on('fs.read', (_, e) => ({ value: FILES[e.path.split('/').pop() ?? ''] ?? '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)

  await $.session.start(START)
  expect(status.at(-1)).toBe('reins: 1 held · reins pending')
  files = []
  await clock.advance(5000)
  expect(status.at(-1)).toBeUndefined()
})
