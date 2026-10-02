export type Held = { id: string; session: string; tool: string; rule: string; what: string; ts: number; reason: string; cwd: string; lines: string[]; cut: number; mine?: boolean }

declare module 'claude-code' {
  interface PluginState {
    'reins-status': { held: readonly Held[] }
  }
}
