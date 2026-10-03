export type Stats = {
  /** Main-loop turns where Jeffort picked a level different from the session's. */
  changed: number
  /** Main-loop turns where it applied a level (same or different). */
  applied: number
  /** Estimated output tokens saved against the session's own effort; negative means spent more. */
  tokensSaved: number
  /** The same in dollars, for models with a known price. */
  usdSaved: number
  /** Actual output tokens on applied turns. */
  outputTokens: number
  /** Cache tokens rebuilt by effort changes (a one-time cost per conversation). */
  rebuiltTokens: number
  /** What those rebuilds cost, in dollars for models with a known cache-write price. */
  rebuildUsd: number
}

export type Last = { level: string; baseline: string; score: number } | null

/** One applied turn, kept in memory for this session only (never written to disk). */
export type TurnLog = {
  at: number
  /** The first 80 characters of the prompt, one line. */
  excerpt: string
  level: string
  baseline: string
  outputTokens: number
  saved: number
  /** Jev's raw 0-3 score for each dimension. */
  dims: Record<string, number>
}

export type PaneTab = 'stats' | 'look'

declare module 'claude-code' {
  interface PluginState {
    jeffort: {
      enabled: boolean
      stats: Stats
      lifetime: Stats
      last: Last
      theme: string
      barStyle: string
      counts: Record<string, number>
      turns: TurnLog[]
      tab: PaneTab
    }
  }
}
