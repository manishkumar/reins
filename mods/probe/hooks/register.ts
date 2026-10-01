import type { Register } from 'claude-code'

// Each behaviour is selected by a marker in the Bash command, so one module
// covers every probe in probe.test.ts. Not for use in a real session.

// Present in the mod environment on 2.1.287 but absent from its declarations.
declare const setTimeout: (fn: () => void, ms: number) => unknown

// Time spent in the hook itself, with no `$` call in flight.
const spin = (ms: number): void => {
  const until = Date.now() + ms
  while (Date.now() < until) {
    // busy
  }
}

// Time spent waiting in the hook itself, the event loop free.
const wait = (ms: number): Promise<void> => new Promise(done => setTimeout(done, ms))

export const register: Register = on => {
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const c = e.command

    if (c.includes('probe:throw')) {
      throw new Error('probe threw')
    }

    if (c.includes('probe:spin')) {
      // Blocks the event loop. The engine cannot cut this off: the deny below
      // stands however long the spin was.
      spin(Number(c.split('=')[1] ?? 10500))
      await Promise.resolve()

      return { deny: 'probe: held after spinning' }
    }

    if (c.includes('probe:wait')) {
      await wait(Number(c.split('=')[1] ?? 10500))

      return { deny: 'probe: held after waiting' }
    }

    if (c.includes('probe:ask')) {
      await wait(6000)
      const answer = await $.ui.ask('Approve this call?', ['Approve', 'Deny'])

      return answer === 'Approve' ? next(e) : { deny: `probe: dialog answered ${answer}` }
    }

    if (c.includes('probe:rewrite')) {
      return next({ ...e, command: `${c} [seen by mod]` })
    }

    return next(e)
  })

  on('tool.call', { tool: 'Read' }, async () => {
    await wait(10500)

    return { deny: 'probe: held after waiting' }
  }).catch(() => ({ deny: 'probe: the catch handler answered' }))
}
