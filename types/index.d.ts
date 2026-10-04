export type Stats = {
  /** Turns (subagents' included) where Jeffort picked a level different from the session's. */
  changed: number
  /** Turns (subagents' included) where it applied a level (same or different). */
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

/** The latest main-loop pick, and whether it was applied (`on`) or only recorded (`audit`). */
export type Last = { level: string; baseline: string; score: number; mode: 'on' | 'audit' } | null

/** One scored turn, kept in memory for this session only (never written to disk). */
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
  /** Jev's confidence in each of those scores, 0-1. */
  confidences: Record<string, number>
}

/**
 * The current project's totals across sessions, kept in the store under its full root path. In
 * `auditStats`, `tokensSaved` is what Jeffort's picks would have saved against the effort that ran,
 * and `outputTokens` the tokens that actually ran.
 */
export type Project = { root: string; name: string; stats: Stats; auditStats: Stats } | null

export type PaneTab = 'stats' | 'look'

declare module 'claude-code' {
  interface PluginState {
    jeffort: {
      mode: 'on' | 'audit' | 'off'
      stats: Stats
      lifetime: Stats
      auditStats: Stats
      auditLifetime: Stats
      auditCounts: Record<string, number>
      auditTurns: TurnLog[]
      project: Project
      last: Last
      theme: string
      barStyle: string
      counts: Record<string, number>
      turns: TurnLog[]
      tab: PaneTab
    }
  }
}
