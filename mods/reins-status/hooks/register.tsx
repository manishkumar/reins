import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Held } from '../types'

/**
 * The reins hold queue, shown inside Claude Code. Read-only on purpose.
 *
 * It reads `.reins/pending/*.json` (the same plain files `reins pending`
 * reads). A count sits in the status line and in one line above the prompt,
 * a new hold is announced once, and `/reins` opens a pane beside the
 * conversation with each hold's full input. The queue is
 * the repository's: holds from other sessions are listed too, and this
 * session's are marked. It has no approve or deny control, and it hooks no
 * `tool.call`: approvals go through `reins approve` and the `reins watch`
 * cockpit only (CLAUDE.md, invariant 13). The mod engine skips a hook that
 * fails or runs out of time, so a gate here would fail open
 * (docs/mods-probe.md). A view that fails shows nothing, which is safe.
 */

const PANE = 'reins'
const PANE_TITLE = 'reins holds'
/** How much of one input the pane carries. The rest is in `reins watch`. */
const MAX_LINES = 150
const MAX_LINE = 400
/** How far up from the session's root to look for `.reins`. */
const MAX_UP = 12
const REFRESH_MS = 5000

const held = atom({ plugin: 'reins-status', key: 'held' } as const, [] as readonly Held[])

/** Text from an agent run is data. Control characters never reach the terminal. */
export const clean = (s: string, max: number): string => {
  const flat = s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
    .replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

const describe = (tool: string, input: unknown): string => {
  if (input !== null && typeof input === 'object') {
    const o = input as Record<string, unknown>
    for (const k of ['command', 'file_path', 'path', 'url']) {
      if (typeof o[k] === 'string') {
        return o[k]
      }
    }
  }

  return tool
}

/** One line of an input for the pane: indentation kept, control characters gone. */
const cleanLine = (s: string): string => {
  const flat = s
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)?/g, '')
    .replace(/\t/g, '  ')
    .replace(/[\x00-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, ' ')
    .trimEnd()

  return flat.length > MAX_LINE ? `${flat.slice(0, MAX_LINE - 1)}…` : flat
}

/** The whole input as lines, and how many lines were left out. */
export const inputLines = (text: string): { lines: string[]; cut: number } => {
  const all = text.replace(/\r\n?/g, '\n').split('\n')

  return { lines: all.slice(0, MAX_LINES).map(cleanLine), cut: Math.max(0, all.length - MAX_LINES) }
}

const clock = (ts: number): string => (ts > 0 ? new Date(ts).toTimeString().slice(0, 5) : '')

/** One pending file as a row, or null when it is not a parked action. */
export const parse = (text: string): Held | null => {
  try {
    const p = JSON.parse(text) as Record<string, unknown>
    if (typeof p.id !== 'string' || typeof p.tool !== 'string') {
      return null
    }
    const ts = Date.parse(String(p.ts))
    const { lines, cut } = inputLines(describe(p.tool, p.input))

    return {
      id: clean(p.id, 16),
      session: typeof p.session_id === 'string' ? p.session_id : '',
      tool: clean(p.tool, 24),
      rule: clean(String(p.rule_id ?? ''), 32),
      what: clean(describe(p.tool, p.input), 70),
      ts: Number.isFinite(ts) ? ts : 0,
      reason: clean(String(p.reason ?? ''), 200),
      cwd: clean(String(p.cwd ?? ''), 200),
      lines,
      cut,
    }
  } catch {
    return null
  }
}

/** The directories from `dir` up to the filesystem root, nearest first. */
export const upward = (dir: string): string[] => {
  const out: string[] = []
  let at = dir.replace(/[\\/]+$/, '')
  for (let i = 0; i < MAX_UP; i++) {
    out.push(at === '' ? '/' : at)
    const cut = Math.max(at.lastIndexOf('/'), at.lastIndexOf('\\'))
    if (cut < 0) {
      break
    }
    at = at.slice(0, cut)
    if (at === '' || /^[A-Za-z]:$/.test(at)) {
      out.push(at === '' ? '/' : `${at}\\`)
      break
    }
  }

  return out
}

/**
 * The folder holding `.reins`, found the way reins finds it: the nearest one
 * at or above where the session stands. A session started in a subdirectory
 * still sees its repository's queue.
 */
const pendingDir = async ($: EngineInterface): Promise<string | null> => {
  for (const dir of upward(await $.session.root())) {
    const reins = `${dir.replace(/[\\/]$/, '')}/.reins`
    const found = await $.fs.stat(reins).catch(() => null)
    if (found?.kind === 'dir') {
      return `${reins}/pending`
    }
  }

  return null
}

// The ids already announced. Null until the first read, which announces
// nothing: holds that were waiting when the session started are in the band.
let known: Set<string> | null = null

const refresh = async ($: EngineInterface): Promise<void> => {
  let rows: Held[] = []
  try {
    const dir = await pendingDir($)
    if (dir !== null) {
      const entries = await $.fs.list(dir)
      const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json')).slice(0, 50)
      const texts = await Promise.all(files.map(f => $.fs.read(`${dir}/${f.name}`).catch(() => '')))
      const me = await $.session.id().catch(() => '')
      rows = texts
        .map(parse)
        .filter((r): r is Held => r !== null)
        .map(r => ({ ...r, mine: r.session !== '' && r.session === me }))
      rows.sort((a, b) => a.ts - b.ts)
    }
  } catch {
    // No .reins/pending here, or it is unreadable: nothing to show.
  }
  await update($, held, () => rows)
  // Claude Code puts the mod's name in front of this, so it does not say "reins" again.
  $.ui.status(rows.length > 0 ? `${rows.length} held · /reins` : undefined)

  const fresh = known === null ? [] : rows.filter(r => !known?.has(r.id))
  known = new Set(rows.map(r => r.id))
  const first = fresh[0]
  if (first !== undefined) {
    const rest = fresh.length > 1 ? ` (+${fresh.length - 1} more)` : ''
    $.ui.toast(`reins: held ${first.tool} [${first.rule}] ${first.what}${rest} · /reins to read it`, { timeoutMs: 8000 })
  }
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    // Without the command there is no pane. The count and the line above the prompt still work.
    await $.command
      .register({ name: 'reins', description: 'Show the reins hold queue in a pane, with each full input' })
      .catch(() => undefined)
    await refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))

    return next(e)
  })

  // A hold parks during a turn, at a tool call. Reading again here shows it
  // without waiting for the timer.
  on('turn.complete', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  // The pane opens only when asked for. Opened unasked on the main screen it
  // would sit above the prompt and take the place of the conversation.
  on('command.run', { command: 'reins' }, async $ => {
    await refresh($)
    const rows = await read($, held)
    const opened = await $.ui.open({ id: PANE, title: PANE_TITLE })
    const count = rows.length === 0 ? 'Nothing is held.' : `${rows.length} held.`

    return { text: opened.isPlaced ? `${count} The reins pane is open.` : `${count} The reins pane could not be shown here: reins pending` }
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const rows = await read($, held)

    return (
      <Box flexDirection="column">
        {rows.length === 0 && <Text dimColor>Nothing is held.</Text>}
        {rows.map(r => (
          <Box key={r.id} flexDirection="column" marginBottom={1}>
            <Text bold>
              {r.id} · {r.tool}
              {clock(r.ts) === '' ? '' : ` · parked ${clock(r.ts)}`}
              {r.mine ? ' · this session' : ''}
            </Text>
            <Text dimColor>
              [{r.rule}] {r.reason}
            </Text>
            {r.cwd !== '' && <Text dimColor>in {r.cwd}</Text>}
            {r.lines.map((line, i) => (
              <Text key={`${r.id}-${i}`}>{line === '' ? ' ' : line}</Text>
            ))}
            {r.cut > 0 && <Text dimColor>… {r.cut} more lines. The whole input is in reins watch.</Text>}
            <Text dimColor>
              reins approve {r.id} · reins deny {r.id}
            </Text>
          </Box>
        ))}
        {rows.length > 0 && <Text dimColor>Answered in a terminal. This pane shows the queue and cannot answer it.</Text>}
      </Box>
    )
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, held)
    if (e.props.hasSurvey || rows.length === 0) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const first = rows[0]

    return (
      <Box flexDirection="column">
        <Text bold>
          reins: {rows.length} held, waiting on you
        </Text>
        <Text dimColor>
          {first?.id} {first?.tool} [{first?.rule}] {first?.what}
          {rows.length > 1 ? ` (+${rows.length - 1} more)` : ''} · /reins to read {rows.length > 1 ? 'them' : 'it'}
        </Text>
      </Box>
    )
  })
}
