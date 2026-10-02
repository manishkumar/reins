import { expect, mock, test } from 'claude-code/testing'

import { clean, inputLines, parse, upward } from './register'

// Run with: claude plugin test mods/reins-status
const hold = (id: string, command: string, ts: string, session = 's1') =>
  JSON.stringify({ id, session_id: session, tool: 'Bash', input: { command }, rule_id: 'push-hold', reason: 'r', transport: 'deny', ts })

const FILES: Record<string, string> = {
  'a1.json': hold('a1', 'git push origin main', '2026-10-01T10:00:02Z'),
  'b2.json': hold('b2', 'npm publish', '2026-10-01T10:00:01Z'),
  'c3.json': 'not json',
  'notes.txt': 'ignored',
}

const entry = (name: string) => ({ name, kind: 'file' as const, size: 1, mtimeMs: 0, isLink: false })

const START = { cwd: '/work/app/packages/web', surface: 'terminal', isInteractive: true } as const
const DIR = { kind: 'dir' as const, size: 0, mtimeMs: 0, isLink: false }

// The session stands two levels below the repository that holds .reins.
const standIn = (on: Parameters<Parameters<typeof test>[1]>[1], root = '/work/app/packages/web', session = 'me') => {
  on('session.root', () => ({ value: root }))
  on('session.id', () => ({ value: session }))
  on('command.register', () => ({ value: undefined }))
  on('fs.stat', (_, e) => {
    if (e.path !== '/work/app/.reins') {
      throw new Error('ENOENT')
    }

    return { value: DIR }
  })
}
const PANE = { component: 'Pane' as const, requestId: 'reins', props: { title: 'reins holds', isFocused: false, bodyColumns: 60, placement: 'dock' } as never }
const BAND = { component: 'AbovePrompt' as const, props: { hasSurvey: false, isWorking: false } as never }

test('clean: escape sequences and control characters never reach the screen', () => {
  expect(clean('git push\x1b]52;c;ZXZpbA==\x07 \x1b[2J origin\nmain', 70)).toBe('git push origin main')
  expect(clean('a'.repeat(100), 10)).toBe(`${'a'.repeat(9)}…`)
  expect(parse('{"id":1}')).toBe(null)
  expect(parse(hold('a1', 'x\x1b[31my', '2026-10-01T10:00:02Z'))?.what).toBe('xy')
})

test('holds on disk become a status line and a band, oldest first', async ($, on) => {
  mock.clock(on)
  standIn(on)
  const status: (string | undefined)[] = []
  on('ui.status', (_, e) => {
    status.push(e.text)

    return { value: undefined }
  })
  const listed: string[] = []
  on('fs.list', (_, e) => {
    listed.push(e.path)

    return { value: Object.keys(FILES).map(entry) }
  })
  on('fs.read', (_, e) => ({ value: FILES[e.path.split('/').pop() ?? ''] ?? '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)

  await $.session.start(START)
  expect(status.at(-1)).toBe('2 held · /reins')
  expect(listed.at(-1)).toBe('/work/app/.reins/pending')

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'reins-status', surface, ...BAND })
    expect(await ui.find({ type: 'Text', text: /reins: 2 held, waiting on you/ })).toBeDefined()
    const rows = await ui.findAll({ type: 'Text', text: /push-hold/ })
    expect(rows.length).toBe(1)
    expect(rows[0]?.text).toContain('b2 Bash [push-hold] npm publish (+1 more) · /reins to read them')
    // A view only: nothing on it can be pressed.
    expect((await ui.findAll({ type: 'Button' })).length).toBe(0)
    await ui.unmount()
  }
})

test('no .reins directory: no status line, and the band passes', async ($, on) => {
  mock.clock(on)
  standIn(on)
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
  standIn(on)
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
  expect(status.at(-1)).toBe('1 held · /reins')
  files = []
  await clock.advance(5000)
  expect(status.at(-1)).toBeUndefined()
})

test('upward: the directories above a path, nearest first', () => {
  expect(upward('/work/app/packages/web/')).toEqual(['/work/app/packages/web', '/work/app/packages', '/work/app', '/work', '/'])
  expect(upward('C:\\work\\app')).toEqual(['C:\\work\\app', 'C:\\work', 'C:\\'])
})

test('a hold that parks during the session is announced once, and this session\'s holds are marked', async ($, on) => {
  const clock = mock.clock(on)
  standIn(on)
  const mine = hold('d4', 'terraform apply', '2026-10-01T10:00:03Z', 'me')
  let files: Record<string, string> = { 'b2.json': FILES['b2.json'] ?? '' }
  const toasts: string[] = []
  on('ui.toast', (_, e) => {
    toasts.push(e.text)

    return { value: undefined }
  })
  on('ui.status', () => ({ value: undefined }))
  on('fs.list', () => ({ value: Object.keys(files).map(entry) }))
  on('fs.read', (_, e) => ({ value: files[e.path.split('/').pop() ?? ''] ?? '' }))
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)

  await $.session.start(START)
  expect(toasts.length).toBe(0)

  files = { ...files, 'd4.json': mine }
  await clock.advance(5000)
  expect(toasts).toEqual(['reins: held Bash [push-hold] terraform apply · /reins to read it'])
  await clock.advance(5000)
  expect(toasts.length).toBe(1)

  const ui = await $.ui.mount({ plugin: 'reins-status', surface: 'terminal', ...PANE })
  expect(await ui.find({ type: 'Text', text: /d4 · Bash · parked \d\d:\d\d · this session/ })).toBeDefined()
  expect((await ui.findAll({ type: 'Text', text: /this session/ })).length).toBe(1)
  await ui.unmount()
})

test('inputLines: every line of an input, indentation kept, control characters gone', () => {
  const { lines, cut } = inputLines("python3 - <<'EOF'\n\tif x:\r\n    run('a\x1b[2Jb')\nEOF")
  expect(lines).toEqual(["python3 - <<'EOF'", '  if x:', "    run('ab')", 'EOF'])
  expect(cut).toBe(0)
  expect(inputLines(Array.from({ length: 200 }, () => 'x').join('\n')).cut).toBe(50)
})

test('the pane shows the whole input of each hold and has nothing to press', async ($, on) => {
  mock.clock(on)
  standIn(on)
  const long = hold('e5', "python3 - <<'EOF'\nimport io\ns = 'npm publish --tag next'\nEOF", '2026-10-01T10:00:05Z')
  on('ui.status', () => ({ value: undefined }))
  on('fs.list', () => ({ value: [entry('e5.json')] }))
  on('fs.read', () => ({ value: long }))
  on('session.start', (_, e) => ({ cwd: e.cwd }) as never)

  await $.session.start(START)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'reins-status', surface, ...PANE })
    expect(await ui.find({ type: 'Text', text: /^import io$/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /s = 'npm publish --tag next'/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /\[push-hold\] r/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /reins approve e5 · reins deny e5/ })).toBeDefined()
    expect((await ui.findAll({ type: 'Button' })).length).toBe(0)
    await ui.unmount()
  }
})
