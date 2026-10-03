// Jeffort: scores each prompt with TypeSafe Jev and sets the effort level for the turn.
//
// The model is never touched. Only `effort` is rewritten, and only on models where Claude Code
// keeps the prompt cache across effort changes (see policy.ts). Everything fails open: any
// problem leaves the session's own effort in place.

import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register } from 'claude-code'

import type { Last, PaneTab, Stats, TurnLog } from '../types'
import {
  BAR_STYLES,
  BAR_STYLE_IDS,
  DEFAULT_BAR_STYLE,
  DEFAULT_THEME,
  LEVELS,
  MIN_CLAUDE_CODE,
  REBUILD_MIN_TOKENS,
  THEMES,
  THEME_IDS,
  allowedLevels,
  barModel,
  buildRequest,
  cacheWritePrice,
  cleanPrompt,
  decide,
  estimateSaved,
  isBarStyle,
  isCacheSafeModel,
  isLevel,
  isSupportedVersion,
  isTheme,
  levelColor,
  mix,
  outputPrice,
  paletteOf,
  parseEnv,
  shares,
} from './policy'
import type { Dims, Level, Palette } from './policy'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
/** Per-request budget; routing must never hold up a turn for long. */
const JEV_TIMEOUT_MS = 3000
const MAX_TURNS_REMEMBERED = 20
const MAX_TURN_LOG = 50
const COMMAND = 'jeffort'
const PANE = 'jeffort'
const STORE_KEY = 'jeffort'
/** The store key this mod used before it was called Jeffort; read once to carry totals over. */
const LEGACY_STORE_KEY = 'auto-effort'

const enabled = atom({ plugin: 'jeffort', key: 'enabled' } as const, true)
/** This session only: what the bar draws. */
const stats = atom({ plugin: 'jeffort', key: 'stats' } as const, emptyStats())
/** Across sessions: kept in the store and shown by /jeffort. */
const lifetime = atom({ plugin: 'jeffort', key: 'lifetime' } as const, emptyStats())
const last = atom({ plugin: 'jeffort', key: 'last' } as const, null as Last)
const theme = atom({ plugin: 'jeffort', key: 'theme' } as const, DEFAULT_THEME)
/** This session only, in memory: prompt excerpts are never written to disk. */
const turns = atom({ plugin: 'jeffort', key: 'turns' } as const, [] as TurnLog[])
const barStyle = atom({ plugin: 'jeffort', key: 'barStyle' } as const, DEFAULT_BAR_STYLE)
/** This session only: how many turns ran at each effort level. */
const counts = atom({ plugin: 'jeffort', key: 'counts' } as const, mix([]) as Record<string, number>)
const tab = atom({ plugin: 'jeffort', key: 'tab' } as const, 'stats' as PaneTab)

function emptyStats(): Stats {
  return { changed: 0, applied: 0, tokensSaved: 0, usdSaved: 0, outputTokens: 0, rebuiltTokens: 0, rebuildUsd: 0 }
}

type Auth = { key: string; model: string }

const DEFAULT_MODEL = 'jev-latest'

/** `.env` values, cached once they hold a key so turns do not re-read the files. */
let cachedVars: Record<string, string> | undefined

/** Merges both `.env` files; where both set a variable, the one beside the plugin wins. */
async function fileVars($: Engine): Promise<Record<string, string>> {
  if (cachedVars) return cachedVars
  const vars: Record<string, string> = {}
  const home = await $.env.get('HOME')
  for (const path of [`${$.plugin.root}/.env`, `${home}/.config/jeffort/.env`]) {
    try {
      for (const [k, v] of Object.entries(parseEnv(await $.fs.read(path)))) vars[k] ??= v
    } catch {
      // not there: try the next place
    }
  }
  if (vars.TYPESAFE_API_KEY) cachedVars = vars
  return vars
}

/**
 * Credentials come from process variables, then `.env` beside the plugin, then
 * `~/.config/jeffort/.env`. The last one is for an installed copy: Claude Code runs it from its
 * plugin cache, where a gitignored `.env` is not copied.
 */
async function credentials($: Engine): Promise<Auth | undefined> {
  const vars = await fileVars($)
  const key = (await $.env.get('TYPESAFE_API_KEY')) || vars.TYPESAFE_API_KEY
  if (!key) return undefined
  return { key, model: (await $.env.get('TYPESAFE_MODEL')) || vars.TYPESAFE_MODEL || DEFAULT_MODEL }
}

async function score($: Engine, auth: Auth, prompt: string, assistantModel: string, levels: readonly Level[]) {
  const body = JSON.stringify(buildRequest(prompt, assistantModel, auth.model))
  // The engine's clock, not setTimeout (not part of the plugin runtime); aborted once the race settles.
  const stop = new AbortController()
  const reply = await Promise.race([
    $.http.fetch(JEV_URL, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth.key}`, 'content-type': 'application/json' },
      body,
    }),
    $.clock
      .sleep(JEV_TIMEOUT_MS, { signal: stop.signal })
      .then(() => null)
      .catch(() => null),
  ]).finally(() => stop.abort())
  if (!reply?.ok) return null
  return decide(JSON.parse(reply.text), levels)
}

const compact = (n: number): string => {
  const a = Math.abs(n)
  const s = a >= 1000 ? `${(a / 1000).toFixed(1)}k` : String(a)
  return n < 0 ? `-${s}` : s
}

const net = (s: Stats): number => s.usdSaved - s.rebuildUsd
const money = (n: number): string => `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`

async function persist($: Engine) {
  await $.store.set(STORE_KEY, {
    enabled: await read($, enabled),
    stats: await read($, lifetime),
    theme: await read($, theme),
    barStyle: await read($, barStyle),
  })
}

async function setEnabled($: Engine, value: boolean) {
  await update($, enabled, () => value)
  await persist($)
}

async function setTheme($: Engine, id: string) {
  await update($, theme, () => id)
  await persist($)
}

async function setBarStyle($: Engine, id: string) {
  await update($, barStyle, () => id)
  await persist($)
}

async function openPane($: Engine) {
  await $.ui.open({ id: PANE, title: 'Jeffort' })
}

function addTurn(s: Stats, turn: Stats): Stats {
  return {
    changed: s.changed + turn.changed,
    applied: s.applied + turn.applied,
    tokensSaved: s.tokensSaved + turn.tokensSaved,
    usdSaved: s.usdSaved + turn.usdSaved,
    outputTokens: s.outputTokens + turn.outputTokens,
    rebuiltTokens: s.rebuiltTokens + turn.rebuiltTokens,
    rebuildUsd: s.rebuildUsd + turn.rebuildUsd,
  }
}

type Pick = { level: Level | null; baseline: Level | null; model: string; score?: number; dims?: Dims; excerpt: string }

type Primitives = { Box: any; Text: any }

/** The stacked bar: what you used, what you saved, and any overspend, sized by token count. */
function bar({ Box }: Primitives, p: Palette, s: Stats) {
  const { used, saved, over } = barModel(s.outputTokens, s.tokensSaved)
  return (
    <Box width="100%" height={1}>
      {used > 0 ? <Box flexGrow={used} minWidth={1} backgroundColor={p.used} /> : null}
      {over > 0 ? <Box flexGrow={over} minWidth={1} backgroundColor={p.over} /> : null}
      {saved > 0 ? <Box flexGrow={saved} minWidth={1} backgroundColor={p.saved} /> : null}
    </Box>
  )
}

/** The effort-mix bar: one segment per level, sized by how many turns ran at it. */
function mixBar({ Box }: Primitives, p: Palette, c: Record<string, number>) {
  return (
    <Box width="100%" height={1}>
      {LEVELS.filter((l) => (c[l] ?? 0) > 0).map((l) => (
        <Box key={`seg-${l}`} flexGrow={c[l]} minWidth={1} backgroundColor={p[l]} />
      ))}
    </Box>
  )
}

/** Percentages in the level colours, e.g. low 45% medium 27% high 27%. */
function mixLegend({ Box, Text }: Primitives, p: Palette, c: Record<string, number>) {
  const pct = shares(mix(LEVELS.flatMap((l) => Array<Level>(c[l] ?? 0).fill(l))))
  return (
    <Box gap={2}>
      {LEVELS.filter((l) => pct[l] > 0).map((l) => (
        <Text key={`pct-${l}`} color={p[l]}>
          {l} {pct[l]}%
        </Text>
      ))}
    </Box>
  )
}

function barLegend(s: Stats): string {
  const { used, saved, over } = barModel(s.outputTokens, s.tokensSaved)
  return (
    `used ${compact(used)}` +
    `${over > 0 ? ` · extra ${compact(over)}` : ''}` +
    `${saved > 0 ? ` · saved ${compact(saved)}` : ''} output tokens · net ~${money(net(s))} after ` +
    `${compact(s.rebuiltTokens)} cache rebuilt`
  )
}

export const register: Register = (on, options) => {
  // The prompt as typed, held until the turn's first model request asks for it.
  let pendingPrompt: string | undefined
  // What was chosen for each turn, so its tool-loop continuations reuse it (one Jev call per
  // turn) and turn.complete can price it.
  const picks = new Map<string, Pick>()
  // Effort in effect on the previous main turn (applied or the session's own), to spot the
  // one-time cache rebuild.
  let previousLevel: Level | null = null
  // Whether this Claude Code keeps the prompt cache across effort changes; older ones never call Jev.
  let supportedVersion = false

  on('session.start', async ($, e, next) => {
    try {
      supportedVersion = isSupportedVersion((await $.session.version()).base)
    } catch {
      supportedVersion = false
    }
    if (!supportedVersion) $.ui.status(`Jeffort: needs Claude Code ${MIN_CLAUDE_CODE} or later; off`)
    try {
      const saved = (await $.store.get(STORE_KEY)) ?? (await $.store.get(LEGACY_STORE_KEY))
      const s = saved as { enabled?: boolean; stats?: Stats; theme?: string; barStyle?: string } | undefined
      await update($, enabled, () => s?.enabled ?? options.enabled !== false)
      if (s?.stats) await update($, lifetime, () => ({ ...emptyStats(), ...s.stats }))
      if (isTheme(s?.theme)) await update($, theme, () => s!.theme as string)
      if (isBarStyle(s?.barStyle)) await update($, barStyle, () => s!.barStyle as string)
    } catch {
      // first run, or an unreadable store: defaults stand
    }
    await $.command.register({
      name: COMMAND,
      description: 'Open the Jeffort pane, or toggle it (on, off) and show estimated savings',
      argumentHint: '[on|off|pane|reset]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase()
    if (arg === 'pane') {
      await openPane($)
      return { text: 'Jeffort pane opened.' }
    }
    if (arg === 'on' || arg === 'off') await setEnabled($, arg === 'on')
    else if (arg === 'reset') {
      await update($, stats, () => emptyStats())
      await update($, lifetime, () => emptyStats())
      await update($, turns, () => [])
      await update($, counts, () => mix([]))
      await persist($)
    } else if (arg === '') await setEnabled($, !(await read($, enabled)))
    const isOn = await read($, enabled)
    const line = (label: string, s: Stats) =>
      `${label}: ${s.changed} of ${s.applied} turns changed effort; ~${compact(s.tokensSaved)} output tokens saved ` +
      `(~${money(s.usdSaved)}) minus ${compact(s.rebuiltTokens)} cache tokens rebuilt ` +
      `(~${money(s.rebuildUsd)}) = ~${money(net(s))} net.`
    return {
      text:
        `Jeffort is ${isOn ? 'on' : 'off'}.\n${line('This session', await read($, stats))}\n` +
        `${line('All sessions', await read($, lifetime))}\n` +
        'Dollar figures cover Opus 5.5 and Sonnet 5.5 only; all savings are estimates from fixed per-level output ratios.',
    }
  })

  on('prompt.submit', ($, e, next) => {
    pendingPrompt = cleanPrompt(e.text)
    return next(e)
  })

  on('turn.step', async function* ($, e, next) {
    // Subagents keep their own effort, and models or Claude Code versions that would lose the
    // cache are left alone: Jev is never called for them.
    const skip = e.agentId || e.effort === undefined || !supportedVersion || !isCacheSafeModel(e.model)
    if (skip || !(await read($, enabled))) {
      return yield* next(e)
    }

    if (!picks.has(e.turnId)) {
      if (picks.size >= MAX_TURNS_REMEMBERED) picks.delete(picks.keys().next().value as string)
      const prompt = pendingPrompt
      pendingPrompt = undefined
      const baseline = isLevel(e.effort) ? e.effort : null
      const pick: Pick = { level: null, baseline, model: e.model, excerpt: (prompt ?? '').replace(/\s+/g, ' ').slice(0, 80) }
      try {
        const auth = prompt ? await credentials($) : undefined
        if (prompt && !auth) {
          $.ui.status('Jeffort: no TYPESAFE_API_KEY in .env')
        } else if (prompt && auth) {
          const decision = await score($, auth, prompt, e.model, allowedLevels(options.floor, options.ceiling))
          if (decision?.level) {
            pick.level = decision.level
            pick.score = decision.score
            pick.dims = decision.dims
            $.ui.status(`Jeffort: ${decision.level} (${decision.score.toFixed(2)}, p=${decision.confidence.toFixed(2)})`)
          } else {
            $.ui.status(`Jeffort: kept ${String(e.effort)} (${decision?.reason ?? 'jev unavailable'})`)
          }
        }
      } catch {
        // fail open: the session's effort stands
      }
      picks.set(e.turnId, pick)
      if (pick.level) await update($, last, () => ({ level: pick.level!, baseline: String(e.effort), score: pick.score ?? 0 }))
    }

    const level = picks.get(e.turnId)?.level
    return yield* next(level ? { ...e, effort: level } : e)
  })

  on('turn.complete', async ($, e, next) => {
    const pick = picks.get(e.turnId)
    picks.delete(e.turnId)
    const before = previousLevel
    if (pick && !e.agentId) previousLevel = pick.level ?? pick.baseline ?? previousLevel
    if (pick?.level && !e.agentId && e.usage) {
      const out = e.usage.output_tokens
      const saved = pick.baseline ? estimateSaved(out, pick.level, pick.baseline) : 0
      const price = outputPrice(e.usage.model)
      const writePrice = cacheWritePrice(e.usage.model)
      const created = e.usage.cache_creation_input_tokens
      const rebuilt = before && before !== pick.level && created > REBUILD_MIN_TOKENS ? created : 0
      const turn: Stats = {
        changed: pick.baseline && pick.baseline !== pick.level ? 1 : 0,
        applied: 1,
        tokensSaved: saved,
        usdSaved: price ? (saved * price) / 1_000_000 : 0,
        outputTokens: out,
        rebuiltTokens: rebuilt,
        rebuildUsd: writePrice ? (rebuilt * writePrice) / 1_000_000 : 0,
      }
      const entry: TurnLog = {
        at: Date.now(),
        excerpt: pick.excerpt,
        level: pick.level,
        baseline: pick.baseline ?? '?',
        outputTokens: out,
        saved,
        dims: pick.dims ?? {},
      }
      await update($, stats, (s) => addTurn(s, turn))
      await update($, lifetime, (s) => addTurn(s, turn))
      await update($, turns, (list) => [...list, entry].slice(-MAX_TURN_LOG))
      await update($, counts, (c) => ({ ...c, [pick.level!]: (c[pick.level!] ?? 0) + 1 }))
      await persist($)
    }
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const s = await read($, stats)
    const l = await read($, last)
    const p = paletteOf(await read($, theme))
    const style = await read($, barStyle)
    const c = await read($, counts)
    const hasBar = isOn && s.applied > 0 && s.outputTokens + Math.abs(s.tokensSaved) > 0

    return (
      <Box flexDirection="column">
        <Box>
          <Button key="open" label="Jeffort" onPress={() => openPane($)} />
          <Text dimColor> {isOn ? 'on · ' : 'off '}</Text>
          {isOn && l ? (
            <Text color={levelColor(p, l.level)}>
              {l.level}
              {l.baseline !== l.level ? ` (was ${l.baseline})` : ''}{' '}
            </Text>
          ) : isOn ? (
            <Text dimColor>waiting for a turn </Text>
          ) : null}
          <Button key="toggle" label={isOn ? 'Turn off' : 'Turn on'} onPress={() => setEnabled($, !isOn)} />
        </Box>
        {hasBar && style === 'mix' ? (
          <Box flexDirection="column">
            {mixBar({ Box, Text }, p, c)}
            <Box gap={2}>
              {mixLegend({ Box, Text }, p, c)}
              <Text dimColor>of turns · net ~{money(net(s))}</Text>
            </Box>
          </Box>
        ) : hasBar ? (
          <Box flexDirection="column">
            {bar({ Box, Text }, p, s)}
            <Text dimColor>this session, est.: {barLegend(s)}</Text>
          </Box>
        ) : null}
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Button, Text } = $.ui.resolve(e)
    const isOn = await read($, enabled)
    const current = await read($, tab)
    const themeId = await read($, theme)
    const styleId = await read($, barStyle)
    const sessionCounts = await read($, counts)
    const p = paletteOf(themeId)
    const rows = e.viewport?.rows ?? 24

    const tabButton = (id: PaneTab, label: string) => (
      <Button key={`tab-${id}`} label={`${current === id ? '●' : '○'} ${label}`} onPress={() => update($, tab, () => id)} />
    )
    const tabs = (
      <Box key="tabs" gap={2}>
        {tabButton('stats', 'Stats')}
        {tabButton('look', 'Appearance')}
      </Box>
    )

    if (current === 'look') {
      return (
        <Box flexDirection="column" gap={1}>
          {tabs}
          <Text dimColor>Pick a theme. It applies to the band and to this pane.</Text>
          {THEME_IDS.map((id) => {
            const t = THEMES[id]!
            const swatch = (c: string, k: string) => <Box key={k} width={3} height={1} backgroundColor={c} />
            return (
              <Box key={id} flexDirection="column">
                <Button key={`theme-${id}`} label={`${themeId === id ? '●' : '○'} ${t.label}`} onPress={() => setTheme($, id)} />
                <Text dimColor>  {t.blurb}</Text>
                <Box paddingLeft={2} gap={1}>
                  <Box width={24} height={1}>
                    <Box flexGrow={12} backgroundColor={t.palette.used} />
                    <Box flexGrow={22} backgroundColor={t.palette.saved} />
                  </Box>
                  {swatch(t.palette.low, 'l')}
                  {swatch(t.palette.medium, 'm')}
                  {swatch(t.palette.high, 'h')}
                  {swatch(t.palette.xhigh, 'x')}
                  <Box width={3} height={1} backgroundColor={t.palette.over} />
                </Box>
              </Box>
            )
          })}
          <Text dimColor>Swatches: used and saved bar, then low, medium, high, xhigh, and extra spend.</Text>
          <Text bold>Bar style</Text>
          {BAR_STYLE_IDS.map((id) => {
            const b = BAR_STYLES[id]!
            const sample = id === 'mix' ? { low: 5, medium: 3, high: 3, xhigh: 0, max: 0 } : null
            return (
              <Box key={id} flexDirection="column">
                <Button key={`bar-${id}`} label={`${styleId === id ? '●' : '○'} ${b.label}`} onPress={() => setBarStyle($, id)} />
                <Text dimColor>  {b.blurb}</Text>
                <Box paddingLeft={2} width={30} height={1}>
                  {sample ? (
                    LEVELS.filter((l) => sample[l] > 0).map((l) => (
                      <Box key={`sample-${l}`} flexGrow={sample[l]} minWidth={1} backgroundColor={p[l]} />
                    ))
                  ) : (
                    <Box width={28} height={1}>
                      <Box flexGrow={12} backgroundColor={p.used} />
                      <Box flexGrow={22} backgroundColor={p.saved} />
                    </Box>
                  )}
                </Box>
              </Box>
            )
          })}
        </Box>
      )
    }

    const s = await read($, stats)
    const all = await read($, lifetime)
    const log = await read($, turns)
    const levels = Object.fromEntries(LEVELS.map((l) => [l, sessionCounts[l] ?? 0])) as Record<Level, number>
    const peak = Math.max(1, ...Object.values(levels))
    const room = Math.max(3, rows - 18)
    const hasBar = s.applied > 0 && s.outputTokens + Math.abs(s.tokensSaved) > 0

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box>
          <Text bold>Jeffort </Text>
          <Text dimColor>{isOn ? 'on ' : 'off '}</Text>
          <Button key="toggle" label={isOn ? 'Turn off' : 'Turn on'} onPress={() => setEnabled($, !isOn)} />
        </Box>
        <Box flexDirection="column">
          <Text dimColor>{styleId === 'mix' ? 'This session, share of turns at each effort' : 'This session, estimated'}</Text>
          {!hasBar ? <Text dimColor>No turns scored yet.</Text> : null}
          {hasBar && styleId === 'mix' ? mixBar({ Box, Text }, p, sessionCounts) : null}
          {hasBar && styleId === 'mix' ? mixLegend({ Box, Text }, p, sessionCounts) : null}
          {hasBar && styleId !== 'mix' ? bar({ Box, Text }, p, s) : null}
          {hasBar ? <Text dimColor>{barLegend(s)}</Text> : null}
        </Box>
        <Text dimColor>
          All sessions: {all.changed} of {all.applied} turns changed · ~{compact(all.tokensSaved)} tokens saved · net ~{money(net(all))}
        </Text>
        <Box flexDirection="column">
          <Text dimColor>Where this session's turns landed</Text>
          {(['low', 'medium', 'high', 'xhigh', 'max'] as const).map((lv) => (
            <Box key={`mix-${lv}`}>
              <Box width={8}>
                <Text color={p[lv]}>{lv}</Text>
              </Box>
              <Box width={24} height={1}>
                {levels[lv] > 0 ? <Box flexGrow={levels[lv]} minWidth={1} backgroundColor={p[lv]} /> : null}
                {levels[lv] < peak ? <Box flexGrow={peak - levels[lv]} /> : null}
              </Box>
              <Text dimColor> {levels[lv]}</Text>
            </Box>
          ))}
        </Box>
        <Box flexDirection="column">
          <Text dimColor>Last turns (newest first, this session only)</Text>
          {log.length === 0 ? <Text dimColor>None yet.</Text> : null}
          {[...log].reverse().slice(0, room).map((t, i) => (
            <Box key={`turn-${t.at}-${i}`} gap={1}>
              <Box width={7}>
                <Text color={levelColor(p, t.level)}>{t.level}</Text>
              </Box>
              <Box width={9}>
                <Text dimColor>← {t.baseline}</Text>
              </Box>
              <Box width={8}>
                <Text dimColor>{compact(t.outputTokens)} out</Text>
              </Box>
              <Text dimColor>{t.excerpt}</Text>
            </Box>
          ))}
        </Box>
      </Box>
    )
  })
}
