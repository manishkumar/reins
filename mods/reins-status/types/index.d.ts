export type Held = { id: string; tool: string; rule: string; what: string; ts: number }

declare module 'claude-code' {
  interface PluginState {
    'reins-status': { held: readonly Held[] }
  }
}
