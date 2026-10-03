// Pure scoring policy for auto-effort: the Jev question, and how its answer becomes a level.
// Kept free of `$` so it can be tested without an engine.

export const LEVELS = ['low', 'medium', 'high', 'xhigh', 'max'] as const
export type Level = (typeof LEVELS)[number]

/**
 * Models whose effort changes keep the prompt cache (Claude Code docs, "Changing effort
 * level"). Anywhere else a rewrite would rebuild the whole conversation, so we do nothing.
 */
const CACHE_SAFE_MODEL = /(opus-5-5|sonnet-5-5|fable-5-1)/

/** Below this Jev confidence the session's own effort stands. */
export const MIN_CONFIDENCE = 0.3

export const isCacheSafeModel = (model: string): boolean => CACHE_SAFE_MODEL.test(model)

/** Oldest Claude Code release that keeps the prompt cache across effort changes. */
export const MIN_CLAUDE_CODE = '2.1.284'

/**
 * Whether a Claude Code release (`2.1.288`, or `2.1.288-dev` for a development build) is at least
 * MIN_CLAUDE_CODE. An unknown or unparseable version is unsupported, so Jeffort does nothing.
 */
export function isSupportedVersion(base: string | undefined): boolean {
  const parse = (v: string) => /^(\d+)\.(\d+)\.(\d+)/.exec(v)?.slice(1).map(Number)
  const have = base ? parse(base) : undefined
  const need = parse(MIN_CLAUDE_CODE)!
  if (!have) return false
  for (let i = 0; i < 3; i++) if (have[i] !== need[i]) return have[i]! > need[i]!
  return true
}

/**
 * How Jev is told which assistant will answer, so depth and scope are judged for that model.
 * A description rather than a bare name: Jev cannot be relied on to know new models.
 */
const ASSISTANTS: Array<[RegExp, { name: string; description?: string }]> = [
  [/opus-5-5/, { name: 'Claude Opus 5.5', description: 'The largest, most capable Claude model.' }],
  [
    /sonnet-5-5/,
    { name: 'Claude Sonnet 5.5', description: 'A mid-size Claude model: fast and strong, but less capable than Opus on hard problems.' },
  ],
  [/fable-5-1/, { name: 'Claude Fable 5.1' }],
]

export const assistantOf = (model: string): { name: string; description?: string } =>
  ASSISTANTS.find(([re]) => re.test(model))?.[1] ?? { name: model }

export const isLevel = (v: unknown): v is Level => LEVELS.includes(v as Level)

/**
 * Whether Jeffort starts a session on. The `enabled` setting set to false wins; otherwise the last
 * `/jeffort` toggle stands, and a first run is on.
 */
export function initialEnabled(stored: unknown, configured: unknown): boolean {
  if (configured === false) return false
  return typeof stored === 'boolean' ? stored : true
}

/** Store keys for per-project totals start with this; the rest is the project root in full. */
export const PROJECT_KEY_PREFIX = 'project:'

/** A project's store key: its full root path, so two folders with the same name never merge. */
export const projectKey = (root: string): string => `${PROJECT_KEY_PREFIX}${root}`

/** A project's display name: the last segment of its root. */
export function projectName(root: string): string {
  const parts = root.split(/[\\/]+/).filter(Boolean)
  return parts[parts.length - 1] ?? root
}

/**
 * Four narrow judgments about a request, each scored on its own ordered scale and combined in
 * code (TypeSafe's composite-scoring pattern). They describe situations, not subjects, so they
 * work for any request to an assistant: code, writing, analysis, planning. Levels run from
 * lowest to highest and are independent descriptions of concrete cases.
 */
const DIMENSIONS = {
  depth: {
    weight: 0.45,
    instructions:
      'How much step-by-step reasoning does the assistant described in `assistant` need to get this request right? ' +
      'A more capable assistant needs less for the same request. The request can be about any subject.',
    criteria: [
      'The answer comes straight from recall or one obvious step: a fact, a definition, a rewording, a simple conversion.',
      'A few straightforward steps with nothing tricky: apply a known method, draft routine text, follow clear instructions.',
      'Several dependent steps or trade-offs to weigh, where a careless pass could get it wrong: diagnose a problem, plan around constraints, analyse an argument.',
      'Deep or novel problem solving: many interacting constraints, subtle edge cases, or reasoning that has to be checked from several angles.',
    ],
  },
  scope: {
    weight: 0.2,
    instructions:
      'How much material, or how many interrelated parts, must the assistant described in `assistant` take into ' +
      'account to answer this request?',
    criteria: [
      'One self-contained item; no outside context is needed.',
      'A single piece of work with a few parts that do not affect each other.',
      'Several parts or sources that depend on each other.',
      'A large or tangled body of material where a change in one part affects many others.',
    ],
  },
  stakes: {
    weight: 0.2,
    instructions: 'How costly is it if the assistant gets this request wrong?',
    criteria: [
      'Nothing depends on it; a wrong answer is harmless or obvious.',
      'A wrong answer is easy to notice and cheap to fix.',
      'A wrong answer could waste significant time or money before anyone notices.',
      'A wrong answer could cause serious, hard-to-reverse harm: security, legal, financial, medical or data loss.',
    ],
  },
  ambiguity: {
    weight: 0.15,
    instructions: 'How clearly does this request define what a correct answer looks like?',
    criteria: [
      'Exactly one correct answer or format, fully specified.',
      'A clear goal with minor gaps the assistant can fill sensibly.',
      'Several reasonable interpretations; the assistant has to decide what is wanted.',
      'Open-ended or underspecified; the assistant has to define the problem itself.',
    ],
  },
} as const

export type Dimension = keyof typeof DIMENSIONS
const DIMENSION_NAMES = Object.keys(DIMENSIONS) as Dimension[]
/** Each scale has four levels, 0 to 3. */
const DIMENSION_MAX = 3

/** Levels the user allows, in order, from `floor` to `ceiling` inclusive. */
export function allowedLevels(floor: unknown, ceiling: unknown): Level[] {
  const lo = isLevel(floor) ? LEVELS.indexOf(floor) : 0
  const hi = isLevel(ceiling) ? LEVELS.indexOf(ceiling) : LEVELS.indexOf('xhigh')
  return LEVELS.slice(Math.min(lo, hi), Math.max(lo, hi) + 1)
}

type JevRequest = {
  model: string
  state: unknown
  questions: Record<string, unknown>
}

/**
 * Only the request and which Claude model will answer it go to Jev: nothing about the session or
 * earlier turns.
 */
export function buildRequest(prompt: string, assistantModel: string, model = 'jev-latest'): JevRequest {
  return {
    model,
    state: { request: prompt, assistant: assistantOf(assistantModel) },
    questions: Object.fromEntries(
      DIMENSION_NAMES.map((d) => [
        d,
        { type: 'score', instructions: DIMENSIONS[d].instructions, criteria: DIMENSIONS[d].criteria },
      ]),
    ),
  }
}

export type Dims = Record<Dimension, number>

export type Decision =
  | { level: Level; score: number; confidence: number; dims: Dims }
  | { level: null; reason: string }

/**
 * Turns Jev's response into a level. Each dimension's score is scaled to 0..1, the weighted sum
 * is mapped linearly across the allowed levels, and the weighted mean confidence gates it: below
 * MIN_CONFIDENCE (or with any dimension missing) the session's own effort stands.
 */
export function decide(body: unknown, levels: readonly Level[]): Decision {
  const answers = (body as { answers?: Record<string, { score?: unknown; confidence?: unknown }> })?.answers
  let composite = 0
  let confidence = 0
  const dims = {} as Dims
  for (const d of DIMENSION_NAMES) {
    const a = answers?.[d]
    const score = a?.score
    const conf = a?.confidence
    if (typeof score !== 'number' || typeof conf !== 'number' || !Number.isFinite(score) || !Number.isFinite(conf)) {
      return { level: null, reason: 'no-answer' }
    }
    const w = DIMENSIONS[d].weight
    dims[d] = score
    composite += w * Math.min(1, Math.max(0, score / DIMENSION_MAX))
    confidence += w * conf
  }
  if (confidence < MIN_CONFIDENCE) return { level: null, reason: 'low-confidence' }
  const index = Math.round(composite * (levels.length - 1))
  const level = levels[index]
  if (!level) return { level: null, reason: 'no-levels' }
  return { level, score: composite, confidence, dims }
}

/**
 * The prompt as a router should see it: Claude Code's injected reminders removed. A subagent's
 * hand-back (an `<agent-message>` frame wrapped in harness prose) is not a prompt at all, so it
 * comes back empty rather than being scored on the frame's wording.
 */
export const cleanPrompt = (text: string): string => {
  const cleaned = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, '').trim()
  return /<agent-message\b/.test(cleaned) ? '' : cleaned
}

/**
 * Output-token multiplier per level, relative to `high`, from bench/ on Opus 5.5. Eight agentic
 * coding tasks gave low 0.58 and xhigh 1.80 against high (6.7k, 11.5k and 20.8k output tokens);
 * ten short Q&A prompts gave 0.37 and 1.22. Real work looks like the first, so those lead.
 * `medium` is interpolated and `max` is a guess: neither was measured on its own. The savings the
 * UI shows are labelled as estimates.
 */
export const OUTPUT_MULTIPLIER: Record<Level, number> = { low: 0.55, medium: 0.75, high: 1, xhigh: 1.7, max: 2.2 }

/** USD per million output tokens, from the Claude Code changelog (v2.1.280, v2.1.284). */
const OUTPUT_PRICE: Array<[RegExp, number]> = [
  [/opus-5-5/, 20],
  [/sonnet-5-5/, 10],
]

/**
 * USD per million tokens written to the one-hour prompt cache (twice the input price: $4 and
 * $2). Matches the cost Claude Code reported for a measured Opus 5.5 turn.
 */
const CACHE_WRITE_PRICE: Array<[RegExp, number]> = [
  [/opus-5-5/, 8],
  [/sonnet-5-5/, 4],
]

export const cacheWritePrice = (model: string): number | undefined =>
  CACHE_WRITE_PRICE.find(([re]) => re.test(model))?.[1]

/**
 * Measured: the first effort change after a conversation starts rebuilds the conversation
 * cache once (about 22k tokens); later changes keep it. A cache write above this on the first
 * request of a turn whose level differs from the previous turn's is counted as that rebuild.
 * Only the first request counts: later ones in a tool loop write tool results to the cache.
 */
export const REBUILD_MIN_TOKENS = 10000

export const outputPrice = (model: string): number | undefined => OUTPUT_PRICE.find(([re]) => re.test(model))?.[1]

/**
 * Estimated output tokens saved by running `chosen` instead of `baseline`, given the tokens
 * the turn actually produced at `chosen`. Negative when `chosen` is the higher level.
 */
export function estimateSaved(outputTokens: number, chosen: Level, baseline: Level): number {
  const atBaseline = (outputTokens * OUTPUT_MULTIPLIER[baseline]) / OUTPUT_MULTIPLIER[chosen]
  return Math.round(atBaseline - outputTokens)
}

/** Parses `KEY=value` lines of a .env file, ignoring comments and surrounding quotes. */
export function parseEnv(text: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line)
    if (!m || m[1] === undefined) continue
    out[m[1]] = m[2]!.replace(/^(['"])(.*)\1$/, '$2')
  }
  return out
}

export type BarModel = { used: number; saved: number; over: number }

/**
 * Segments of the session bar, in estimated output tokens. The whole bar is what your own effort
 * would have cost: `used` plus `saved`. If auto spent more than that, `over` is the overspend
 * and the bar is `used` (less the overspend) plus `over`.
 */
export function barModel(outputTokens: number, tokensSaved: number): BarModel {
  const saved = Math.max(0, tokensSaved)
  const over = Math.max(0, -tokensSaved)
  return { used: Math.max(0, outputTokens - over), saved, over }
}

/** Colours a theme assigns. `over` is extra spend; keep it distinct from `saved` in every theme. */
export type Palette = {
  used: string
  saved: string
  over: string
  rebuild: string
  low: string
  medium: string
  high: string
  xhigh: string
  max: string
}

export type Theme = { label: string; blurb: string; palette: Palette }

/**
 * Predefined themes. Colours are hex except `terminal`, which uses only named colours so it
 * follows whatever palette the user's terminal already has. `mono` trades the saved/extra hue
 * contrast for brightness: extra spend is the brightest segment.
 */
export const THEMES: Record<string, Theme> = {
  default: {
    label: 'Default',
    blurb: 'Blue, green, amber, violet',
    palette: { used: '#5b8def', saved: '#3fbf7f', over: '#e5b43c', rebuild: '#a98bfa', low: '#8fd3b6', medium: '#5b8def', high: '#e5b43c', xhigh: '#ef7a6a', max: '#ff5d8f' },
  },
  signal: {
    label: 'Signal',
    blurb: 'Green for savings, red for overspend',
    palette: { used: '#8892a0', saved: '#2ecc71', over: '#e74c3c', rebuild: '#f1c40f', low: '#2ecc71', medium: '#a3d65c', high: '#f1c40f', xhigh: '#e67e22', max: '#e74c3c' },
  },
  mono: {
    label: 'Mono',
    blurb: 'One teal hue, brightness only',
    palette: { used: '#3b5b56', saved: '#8fe0cf', over: '#ffffff', rebuild: '#5f7f78', low: '#5f7f78', medium: '#7fa89f', high: '#a6d2c8', xhigh: '#d6f5ee', max: '#ffffff' },
  },
  colorsafe: {
    label: 'Colour-safe',
    blurb: 'Okabe-Ito, distinct under red-green colour blindness',
    palette: { used: '#999999', saved: '#56b4e9', over: '#d55e00', rebuild: '#cc79a7', low: '#56b4e9', medium: '#009e73', high: '#e69f00', xhigh: '#d55e00', max: '#cc79a7' },
  },
  retro: {
    label: 'Retro',
    blurb: 'Green phosphor with an amber warning',
    palette: { used: '#1f8f4e', saved: '#5dff9a', over: '#ffb000', rebuild: '#0b6b3a', low: '#2fbf71', medium: '#5dff9a', high: '#b6ff8a', xhigh: '#ffe66d', max: '#ffb000' },
  },
  terminal: {
    label: 'Match terminal',
    blurb: 'Only your terminal\'s own named colours',
    palette: { used: 'blue', saved: 'green', over: 'yellow', rebuild: 'magenta', low: 'cyan', medium: 'blue', high: 'yellow', xhigh: 'red', max: 'magenta' },
  },
}

export const THEME_IDS = Object.keys(THEMES)
export const DEFAULT_THEME = 'default'
export const isTheme = (v: unknown): v is string => typeof v === 'string' && v in THEMES
export const paletteOf = (id: unknown): Palette => THEMES[isTheme(id) ? id : DEFAULT_THEME]!.palette
export const levelColor = (p: Palette, level: string): string => (isLevel(level) ? p[level] : p.used)

/** How many of `levels` landed on each level, in LEVELS order, zeros included. */
export function mix(levels: readonly string[]): Record<Level, number> {
  const out = { low: 0, medium: 0, high: 0, xhigh: 0, max: 0 } as Record<Level, number>
  for (const l of levels) if (isLevel(l)) out[l] += 1
  return out
}

/** Bar styles the band can draw. */
export const BAR_STYLES: Record<string, { label: string; blurb: string }> = {
  savings: { label: 'Savings', blurb: 'Used against estimated saved, with net cost' },
  mix: { label: 'Effort mix', blurb: 'Share of turns at each effort level, in the level colours' },
}
export const BAR_STYLE_IDS = Object.keys(BAR_STYLES)
export const DEFAULT_BAR_STYLE = 'savings'
export const isBarStyle = (v: unknown): v is string => typeof v === 'string' && v in BAR_STYLES

/**
 * Whole-number percentage of turns at each level, summing to exactly 100 (largest remainder), or
 * all zeros when there are no turns.
 */
export function shares(counts: Record<Level, number>): Record<Level, number> {
  const out = { low: 0, medium: 0, high: 0, xhigh: 0, max: 0 } as Record<Level, number>
  const total = LEVELS.reduce((n, l) => n + counts[l], 0)
  if (total <= 0) return out
  const raw = LEVELS.map((l) => (counts[l] * 100) / total)
  LEVELS.forEach((l, i) => {
    out[l] = Math.floor(raw[i]!)
  })
  let left = 100 - LEVELS.reduce((n, l) => n + out[l], 0)
  const order = LEVELS.map((l, i) => ({ l, r: raw[i]! - Math.floor(raw[i]!) })).sort((a, b) => b.r - a.r)
  for (const { l } of order) {
    if (left <= 0) break
    out[l] += 1
    left -= 1
  }
  return out
}
