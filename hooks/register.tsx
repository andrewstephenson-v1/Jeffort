// Jeffort: scores each prompt with TypeSafe Jev and sets the effort level for the turn.
//
// The model is never touched. Only `effort` is rewritten, and only on models where Claude Code
// keeps the prompt cache across effort changes (see policy.ts). Everything fails open: any
// problem leaves the session's own effort in place.

import { atom, read, update } from 'claude-code'
import type { EngineInterface as Engine, Register, TurnCompleteInput, TurnStepInput } from 'claude-code'

import type { Last, PaneTab, Project, Stats, TurnLog } from '../types'
import {
  BAR_STYLES,
  BAR_STYLE_IDS,
  DEFAULT_BAR_STYLE,
  DEFAULT_THEME,
  LEVELS,
  MIN_CLAUDE_CODE,
  PROJECT_KEY_PREFIX,
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
  initialEnabled,
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
  projectKey,
  projectName,
  shares,
} from './policy'
import type { Dims, Level, Palette } from './policy'

const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
/** Per-request budget; routing must never hold up a turn for long. */
const JEV_TIMEOUT_MS = 3000
const MAX_TURNS_REMEMBERED = 20
const MAX_AGENTS_REMEMBERED = 50
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
/** Across sessions, for the project this session is in: kept in the store under its root. */
const project = atom({ plugin: 'jeffort', key: 'project' } as const, null as Project)
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

/**
 * Merges the key files; where several set a variable, the first listed wins. `jeffort.env` is
 * read as well as `.env` because a user's `Read(**\/.env)` permission rule can stop a plugin
 * reading any file named exactly `.env`.
 */
async function fileVars($: Engine): Promise<Record<string, string>> {
  if (cachedVars) return cachedVars
  const vars: Record<string, string> = {}
  const home = await $.env.get('HOME')
  const places = [
    `${$.plugin.root}/.env`,
    `${$.plugin.root}/jeffort.env`,
    `${home}/.config/jeffort/.env`,
    `${home}/.config/jeffort/jeffort.env`,
  ]
  for (const path of places) {
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
 * Credentials come from process variables, then `.env` or `jeffort.env` beside the plugin, then
 * the same two names in `~/.config/jeffort/`. The home folder is for an installed copy: Claude Code
 * runs it from its plugin cache, where a gitignored `.env` is not copied.
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
/** Marks a figure as an estimate: ~$0.01, and -~$1.09 rather than ~-$1.09. */
const approx = (figure: string): string => (figure.startsWith('-') ? `-~${figure.slice(1)}` : `~${figure}`)

async function persist($: Engine) {
  await $.store.set(STORE_KEY, {
    enabled: await read($, enabled),
    stats: await read($, lifetime),
    theme: await read($, theme),
    barStyle: await read($, barStyle),
  })
}

/**
 * Points `project` at the session's project root, reading that project's totals from the store
 * when the root changed (session start, or a `/cd` since). Fails open: totals then go nowhere.
 */
async function loadProject($: Engine): Promise<Project> {
  try {
    const root = await $.session.root()
    const current = await read($, project)
    if (current?.root === root) return current
    const saved = (await $.store.get(projectKey(root))) as { stats?: Stats } | undefined
    const next: Project = { root, name: projectName(root), stats: { ...emptyStats(), ...saved?.stats } }
    await update($, project, () => next)
    return next
  } catch {
    return read($, project)
  }
}

async function persistProject($: Engine) {
  const p = await read($, project)
  if (p) await $.store.set(projectKey(p.root), { stats: p.stats })
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

type Pick = {
  level: Level | null
  baseline: Level | null
  model: string
  score?: number
  dims?: Dims
  excerpt: string
  /** Cache tokens written by the turn's first request, where an effort change rebuilds the cache. */
  firstWrite?: number
}

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
    `${saved > 0 ? ` · saved ${compact(saved)}` : ''} output tokens · net ${approx(money(net(s)))} after ` +
    `${compact(s.rebuiltTokens)} cache rebuilt`
  )
}

/**
 * Scores a prompt and returns what to apply; `level` stays null (the effort in force stands) when
 * there is no prompt, no key, or Jev declines. `label` prefixes a subagent's excerpt, and only the
 * main loop writes the status line, so parallel subagents do not flicker it.
 */
async function pickFor($: Engine, prompt: string | undefined, e: TurnStepInput, levels: readonly Level[], label = ''): Promise<Pick> {
  const baseline = isLevel(e.effort) ? e.effort : null
  const excerpt = `${label}${(prompt ?? '').replace(/\s+/g, ' ')}`.slice(0, 80)
  const pick: Pick = { level: null, baseline, model: e.model, excerpt }
  const status = (text: string) => (e.agentId ? undefined : $.ui.status(text))
  try {
    const auth = prompt ? await credentials($) : undefined
    if (prompt && !auth) {
      status('Jeffort: no TYPESAFE_API_KEY found. Put it in ~/.config/jeffort/.env (project .env files are not read)')
    } else if (prompt && auth) {
      const decision = await score($, auth, prompt, e.model, levels)
      if (decision?.level) {
        pick.level = decision.level
        pick.score = decision.score
        pick.dims = decision.dims
        status(`Jeffort: ${decision.level} (${decision.score.toFixed(2)}, p=${decision.confidence.toFixed(2)})`)
      } else {
        status(`Jeffort: kept ${String(e.effort)} (${decision?.reason ?? 'jev unavailable'})`)
      }
    }
  } catch {
    // fail open: the effort in force stands
  }
  return pick
}

/**
 * A subagent's pick, made once on the task it was given, or null to leave it alone. Left alone:
 * an effort other than the main loop's own (its definition set one), a fork or a teammate (they
 * carry the parent's conversation, so a new level would rebuild its cache), and the engine's own
 * loops (compaction, memory, workflows), which no agent list names.
 */
async function subagentPick(
  $: Engine,
  e: TurnStepInput & { agentId: string },
  inherited: TurnStepInput['effort'],
  levels: readonly Level[],
): Promise<Pick | null> {
  if (e.effort !== inherited) return null
  const info = (await $.agent.list()).find((a) => a.id === e.agentId)
  if (!info || info.type === 'fork' || info.type === 'teammate') return null
  const found = await $.session.messages({ agentId: e.agentId })
  if ('deny' in found) return null
  const prompt = cleanPrompt(found.find((m) => m.role === 'user')?.text ?? '')
  return prompt ? pickFor($, prompt, e, levels, `${info.type}: `) : null
}

/** Adds an applied turn to every total; `rebuilt` is the cache it rebuilt, if any. */
async function record($: Engine, pick: Pick & { level: Level }, usage: NonNullable<TurnCompleteInput['usage']>, rebuilt: number) {
  const out = usage.output_tokens
  const saved = pick.baseline ? estimateSaved(out, pick.level, pick.baseline) : 0
  const price = outputPrice(usage.model)
  const writePrice = cacheWritePrice(usage.model)
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
  if (await loadProject($)) await update($, project, (p) => p && { ...p, stats: addTurn(p.stats, turn) })
  await update($, turns, (list) => [...list, entry].slice(-MAX_TURN_LOG))
  await update($, counts, (c) => ({ ...c, [pick.level]: (c[pick.level] ?? 0) + 1 }))
  await persist($)
  await persistProject($)
}

export const register: Register = (on, options) => {
  // Each turn's prompt by turn id, held until the turn's first model request asks for it. Keyed
  // by turn so prompts queued during a running turn each reach their own turn.
  const prompts = new Map<string, string>()
  // What was chosen for each turn, so its tool-loop continuations reuse it (one Jev call per
  // turn) and turn.complete can price it.
  const picks = new Map<string, Pick>()
  // Effort in effect on the previous main turn (applied or the session's own), to spot the
  // one-time cache rebuild, and kept by a turn that has no prompt to score.
  let previousLevel: Level | null = null
  // Each subagent's pick by agent id, made once on its task and reused by its later turns; null
  // where it is left alone. Forks are noted at spawn, where the engine says which ones are.
  const agentPicks = new Map<string, Pick | null>()
  const forks = new Set<string>()
  // The main loop's own effort on its latest request, before any rewrite: what a subagent inherits.
  let mainEffort: TurnStepInput['effort']
  // Whether this Claude Code keeps the prompt cache across effort changes; older ones never call Jev.
  let supportedVersion = false
  // Whether the session talks to Anthropic directly (an API key or a Claude subscription). Behind
  // Bedrock, Vertex or a gateway the cache may not survive an effort change, so Jeffort stays out.
  let firstParty = true

  on('session.start', async ($, e, next) => {
    try {
      supportedVersion = isSupportedVersion((await $.session.version()).base)
    } catch {
      supportedVersion = false
    }
    if (!supportedVersion) $.ui.status(`Jeffort: needs Claude Code ${MIN_CLAUDE_CODE} or later; off`)
    try {
      firstParty = (await $.session.authorize()) !== null
    } catch {
      // a build without session.authorize: the version gate alone decides, as before
      firstParty = true
    }
    if (supportedVersion && !firstParty) $.ui.status('Jeffort: needs an Anthropic API key or Claude subscription; off')
    let s: { enabled?: boolean; stats?: Stats; theme?: string; barStyle?: string } | undefined
    try {
      s = ((await $.store.get(STORE_KEY)) ?? (await $.store.get(LEGACY_STORE_KEY))) as typeof s
      if (s?.stats) await update($, lifetime, () => ({ ...emptyStats(), ...s!.stats }))
      if (isTheme(s?.theme)) await update($, theme, () => s!.theme as string)
      if (isBarStyle(s?.barStyle)) await update($, barStyle, () => s!.barStyle as string)
    } catch {
      // first run, or an unreadable store: defaults stand
    }
    await update($, enabled, () => initialEnabled(s?.enabled, options.enabled))
    await loadProject($)
    await $.command.register({
      name: COMMAND,
      description: 'Open the Jeffort pane, or toggle it (on, off) and show estimated savings',
      argumentHint: '[on|off|pane|reset|reset all]',
    })
    return next(e)
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const arg = e.args.trim().toLowerCase().replace(/\s+/g, ' ')
    if (arg === 'pane') {
      await openPane($)
      return { text: 'Jeffort pane opened.' }
    }
    const here = await loadProject($)
    if (arg === 'on' || arg === 'off') await setEnabled($, arg === 'on')
    else if (arg === 'reset' || arg === 'reset all') {
      // `reset` clears this session and this project; `reset all` every project and the overall total.
      await update($, stats, () => emptyStats())
      await update($, turns, () => [])
      await update($, counts, () => mix([]))
      if (here) await update($, project, () => ({ ...here, stats: emptyStats() }))
      if (arg === 'reset all') {
        await update($, lifetime, () => emptyStats())
        for (const key of await $.store.keys()) if (key.startsWith(PROJECT_KEY_PREFIX)) await $.store.delete(key)
      }
      await persist($)
      await persistProject($)
    } else if (arg === '') await setEnabled($, !(await read($, enabled)))
    const isOn = await read($, enabled)
    const proj = await read($, project)
    const line = (label: string, s: Stats) =>
      `${label}: ${s.changed} of ${s.applied} turns changed effort; ${approx(compact(s.tokensSaved))} output tokens saved ` +
      `(${approx(money(s.usdSaved))}) minus ${compact(s.rebuiltTokens)} cache tokens rebuilt ` +
      `(${approx(money(s.rebuildUsd))}) = ${approx(money(net(s)))} net.`
    return {
      text:
        `Jeffort is ${isOn ? 'on' : 'off'}.\n${line('This session', await read($, stats))}\n` +
        (proj ? `${line(`This project (${proj.name})`, proj.stats)}\n` : '') +
        `${line('All projects', await read($, lifetime))}\n` +
        'Dollar figures cover Opus 5.5 and Sonnet 5.5 only; all savings are estimates from fixed per-level output ratios.',
    }
  })

  // The prompt the turn actually begins with, after every prompt.submit hook settled or dropped it.
  // "" for a turn started without one (a continuation): those are never scored.
  on('turn.start', ($, e, next) => {
    if (prompts.size >= MAX_TURNS_REMEMBERED) prompts.delete(prompts.keys().next().value as string)
    prompts.set(e.turnId, cleanPrompt(e.text))
    return next(e)
  })

  on('agent.spawn', async ($, e, next) => {
    const result = await next(e)
    if (e.fork && result.agentId) forks.add(result.agentId)
    return result
  })

  on('turn.step', async function* ($, e, next) {
    // What a subagent inherits: the main loop's effort before Jeffort rewrites it.
    if (!e.agentId) mainEffort = e.effort
    // Models, providers or Claude Code versions that would lose the cache are left alone: Jev is
    // never called for them.
    const skip = e.effort === undefined || !supportedVersion || !firstParty || !isCacheSafeModel(e.model)
    if (skip || !(await read($, enabled))) {
      return yield* next(e)
    }

    if (e.agentId) {
      if (!options.subagents) return yield* next(e)
      if (!agentPicks.has(e.agentId)) {
        if (agentPicks.size >= MAX_AGENTS_REMEMBERED) agentPicks.delete(agentPicks.keys().next().value as string)
        let pick: Pick | null = null
        try {
          pick = forks.has(e.agentId)
            ? null
            : await subagentPick($, { ...e, agentId: e.agentId }, mainEffort, allowedLevels(options.floor, options.ceiling))
        } catch {
          // fail open: the subagent's effort stands
        }
        agentPicks.set(e.agentId, pick)
      }
      const chosen = agentPicks.get(e.agentId)
      return yield* next(chosen?.level ? { ...e, effort: chosen.level } : e)
    }

    if (!picks.has(e.turnId)) {
      if (picks.size >= MAX_TURNS_REMEMBERED) picks.delete(picks.keys().next().value as string)
      const prompt = prompts.get(e.turnId)
      prompts.delete(e.turnId)
      // A turn with no prompt (a continuation, or a subagent's hand-back) keeps the last turn's level.
      const pick: Pick =
        prompt || !previousLevel
          ? await pickFor($, prompt, e, allowedLevels(options.floor, options.ceiling))
          : { level: previousLevel, baseline: isLevel(e.effort) ? e.effort : null, model: e.model, excerpt: '(no prompt: kept last level)' }
      picks.set(e.turnId, pick)
      if (pick.level && prompt) await update($, last, () => ({ level: pick.level!, baseline: String(e.effort), score: pick.score ?? 0 }))
    }

    const chosen = picks.get(e.turnId)
    const result = yield* next(chosen?.level ? { ...e, effort: chosen.level } : e)
    if (chosen && e.index === 0 && result.usage) chosen.firstWrite = result.usage.cache_creation_input_tokens
    return result
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId) {
      // A subagent's turns count toward the totals, but never as a cache rebuild: its first
      // request writes a fresh conversation's cache whatever the level.
      const pick = agentPicks.get(e.agentId)
      if (pick?.level && e.usage) await record($, { ...pick, level: pick.level }, e.usage, 0)
      return next(e)
    }
    const pick = picks.get(e.turnId)
    picks.delete(e.turnId)
    prompts.delete(e.turnId)
    const before = previousLevel
    if (pick) previousLevel = pick.level ?? pick.baseline ?? previousLevel
    if (pick?.level && e.usage) {
      const created = pick.firstWrite ?? 0
      const rebuilt = before && before !== pick.level && created > REBUILD_MIN_TOKENS ? created : 0
      await record($, { ...pick, level: pick.level }, e.usage, rebuilt)
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
    // A band taller than its room scrolls, leaving only the first row in view: an open pane or
    // the task list can squeeze it to one or two rows. Drop rows from the bottom instead, and
    // carry the net figure on the first row once the legend no longer fits.
    const room = e.props.maxRows ?? Infinity
    const showBar = hasBar && room >= 2
    const showLegend = hasBar && room >= 3
    const brief = !hasBar || showLegend
      ? null
      : style === 'mix'
        ? `· net ${approx(money(net(s)))}`
        : `· ${approx(compact(s.tokensSaved))} saved · net ${approx(money(net(s)))}`

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
          {brief ? (
            <Text dimColor wrap="truncate-end">
              {' '}
              {brief}
            </Text>
          ) : null}
        </Box>
        {showBar && style === 'mix' ? (
          <Box flexDirection="column">
            {mixBar({ Box, Text }, p, c)}
            {showLegend ? (
              <Box gap={2}>
                {mixLegend({ Box, Text }, p, c)}
                <Text dimColor wrap="truncate-end">of turns · net {approx(money(net(s)))}</Text>
              </Box>
            ) : null}
          </Box>
        ) : showBar ? (
          <Box flexDirection="column">
            {bar({ Box, Text }, p, s)}
            {showLegend ? (
              <Text dimColor wrap="truncate-end">
                this session, est.: {barLegend(s)}
              </Text>
            ) : null}
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
          <Text bold>Band bar style</Text>
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
    const proj = await read($, project)
    const log = await read($, turns)
    const levels = Object.fromEntries(LEVELS.map((l) => [l, sessionCounts[l] ?? 0])) as Record<Level, number>
    const peak = Math.max(1, ...Object.values(levels))
    const room = Math.max(3, rows - 16)
    const scored = s.applied > 0 && s.outputTokens + Math.abs(s.tokensSaved) > 0

    return (
      <Box flexDirection="column" gap={1}>
        {tabs}
        <Box>
          <Text bold>Jeffort </Text>
          <Text dimColor>{isOn ? 'on ' : 'off '}</Text>
          <Button key="toggle" label={isOn ? 'Turn off' : 'Turn on'} onPress={() => setEnabled($, !isOn)} />
        </Box>
        {/* No bar here: the band below already draws it, and the level rows show the mix. */}
        <Box flexDirection="column">
          <Text dimColor>{scored ? `This session, est.: ${barLegend(s)}` : 'No turns scored yet this session.'}</Text>
          {proj ? (
            <Text dimColor>
              This project ({proj.name}): {proj.stats.changed} of {proj.stats.applied} turns changed ·{' '}
              {approx(compact(proj.stats.tokensSaved))} tokens saved · net {approx(money(net(proj.stats)))}
            </Text>
          ) : null}
          <Text dimColor>
            All projects: {all.changed} of {all.applied} turns changed · {approx(compact(all.tokensSaved))} tokens saved · net {approx(money(net(all)))}
          </Text>
        </Box>
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
