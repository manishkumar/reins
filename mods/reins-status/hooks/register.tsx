import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Held } from '../types'

/**
 * The reins hold queue, shown inside Claude Code. Read-only on purpose.
 *
 * It reads `.reins/pending/*.json` (the same plain files `reins pending`
 * reads) and shows a count in the status line and the oldest few holds in a
 * band above the prompt. It has no approve or deny control, and it hooks no
 * `tool.call`: approvals go through `reins approve` and the `reins watch`
 * cockpit only (CLAUDE.md, invariant 13). The mod engine skips a hook that
 * fails or runs out of time, so a gate here would fail open
 * (docs/mods-probe.md). A view that fails shows nothing, which is safe.
 */

const PENDING = '.reins/pending'
const SHOWN = 3
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

/** One pending file as a row, or null when it is not a parked action. */
export const parse = (text: string): Held | null => {
  try {
    const p = JSON.parse(text) as Record<string, unknown>
    if (typeof p.id !== 'string' || typeof p.tool !== 'string') {
      return null
    }
    const ts = Date.parse(String(p.ts))

    return {
      id: clean(p.id, 16),
      tool: clean(p.tool, 24),
      rule: clean(String(p.rule_id ?? ''), 32),
      what: clean(describe(p.tool, p.input), 70),
      ts: Number.isFinite(ts) ? ts : 0,
    }
  } catch {
    return null
  }
}

const refresh = async ($: EngineInterface): Promise<void> => {
  let rows: Held[] = []
  try {
    const entries = await $.fs.list(PENDING)
    const files = entries.filter(f => f.kind === 'file' && f.name.endsWith('.json')).slice(0, 50)
    const texts = await Promise.all(files.map(f => $.fs.read(`${PENDING}/${f.name}`).catch(() => '')))
    rows = texts.map(parse).filter((r): r is Held => r !== null)
    rows.sort((a, b) => a.ts - b.ts)
  } catch {
    // No .reins/pending here, or it is unreadable: nothing to show.
  }
  await update($, held, () => rows)
  $.ui.status(rows.length > 0 ? `reins: ${rows.length} held · reins pending` : undefined)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await refresh($)
    $.clock.every(REFRESH_MS, () => refresh($))

    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    await refresh($)

    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const rows = await read($, held)
    if (e.props.hasSurvey || rows.length === 0) {
      return next(e)
    }
    const { Box, Text } = $.ui.resolve(e)
    const more = rows.length - SHOWN

    return (
      <Box flexDirection="column">
        <Text bold>
          reins: {rows.length} held, waiting on you
        </Text>
        {rows.slice(0, SHOWN).map(r => (
          <Text key={r.id} dimColor>
            {r.id} {r.tool} [{r.rule}] {r.what}
          </Text>
        ))}
        <Text dimColor>
          {more > 0 ? `+${more} more. ` : ''}Answer in a terminal: reins watch, or reins approve {'<id>'}
        </Text>
      </Box>
    )
  })
}
