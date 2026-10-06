import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const MODEL = 'claude-opus-5-5'
const STEPS_PER_TURN = 2

type Usage = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage = (output: number, written: number, read = 0): Usage => ({
  model: MODEL,
  input_tokens: 0,
  output_tokens: output,
  cache_read_input_tokens: read,
  cache_creation_input_tokens: written,
})

/**
 * Everything beneath the plugin a turn touches: an in-memory store, a supported version, a project
 * root the test can move, an API key, Jev answering every dimension with the score `scoreOf` gives
 * the prompt, and a model whose first request writes `firstWrite` cache tokens and later ones 30k.
 */
function world(on: On, scoreOf: (prompt: string) => number) {
  const store = new Map<string, unknown>()
  const w = { store, statuses: [] as Array<string | undefined>, root: '/Users/a/Dev/alpha', asked: [] as string[], effort: new Map<string, unknown>(), firstWrite: 500, firstParty: true, cached: 0, loseCache: false, continues: new Set<string>(), sentStates: [] as any[], agents: [] as Array<{ id: string; type: string; task: string }> }
  on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', async (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('store.keys', async () => ({ value: [...store.keys()] }))
  on('session.start', async (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', async (_$, e) => ({ turnId: e.turnId }))
  on('prompt.submit', async (_$, e) => ({ text: e.text }))
  on('command.register', async () => ({ value: undefined }))
  on('ui.status', async (_$, e) => {
    w.statuses.push(e.text)
    return { value: undefined }
  })
  on('session.version', async () => ({ value: { version: '2.1.290', base: '2.1.290' } }))
  on('session.authorize', async () => ({ value: w.firstParty ? { handle: 'h', kind: 'api-key' as const } : null }))
  on('session.root', async () => ({ value: w.root }))
  on('env.get', async (_$, e) => ({ value: e.name === 'TYPESAFE_API_KEY' ? 'test-key' : undefined }))
  on('fs.read', async () => ({ deny: 'no such file' }))
  on('agent.list', async () => ({
    value: w.agents.map((a) => ({ id: a.id, type: a.type, description: a.task, status: 'running' })),
  }))
  on('session.messages', async (_$, e: any) => {
    const agent = w.agents.find((a) => a.id === e.agentId)
    return { value: agent ? [{ role: 'user', text: agent.task, toolUses: [] }] : [] } as any
  })
  on('clock.sleep', () => new Promise(() => {}))
  let now = 0
  on('clock.now', async () => ({ value: (now += 1000) }))
  on('http.fetch', async (_$, e) => {
    const state = (JSON.parse(e.init?.body ?? '{}') as { state: { request: string } }).state
    w.sentStates.push(state)
    const prompt = state.request
    w.asked.push(prompt)
    const answer = { score: scoreOf(prompt), confidence: 0.9 }
    const answers: Record<string, unknown> = Object.fromEntries(['depth', 'scope', 'stakes', 'ambiguity'].map((d) => [d, answer]))
    answers.continues_previous = { type: 'noul', noul: w.continues.has(prompt) ? 0.9 : 0.05 }
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('turn.step', async function* (_$, e) {
    if (e.index === 0) w.effort.set(e.agentId ? `${e.agentId}/${e.turnId}` : e.turnId, e.effort)
    // A cache that keeps growing, read back whole each request; unless the test makes it lose it.
    const written = e.index === 0 ? w.firstWrite : 30000
    const read = w.loseCache ? 0 : w.cached
    w.cached = read + written
    const u = usage(100, written, read)
    yield { kind: 'stop', stopReason: 'end_turn', usage: u }
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn', usage: u }
  })
  on('turn.complete', async (_$, e) => ({ text: e.answer, usage: e.usage }))
  return w
}

async function steps($: any, turnId: string) {
  for (let index = 0; index < STEPS_PER_TURN; index++) {
    const s = $.turn.step({ turnId, index, model: MODEL, effort: 'high', messageCount: 1 })
    for await (const _ of s) void _
    await s.result
  }
}

async function complete($: any, turnId: string, output = 1000) {
  // The turn's usage is summed over its requests, so its cache writes always look large.
  const written = 500 + 30000 * (STEPS_PER_TURN - 1)
  await $.turn.complete({ turnId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: usage(output, written) })
}

async function turn($: any, turnId: string, text: string) {
  await $.turn.start({ turnId, text })
  await steps($, turnId)
  await complete($, turnId)
}

const overall = (w: { store: Map<string, unknown> }) =>
  ((w.store.get('jeffort') as { stats?: Record<string, number> } | undefined)?.stats ?? {}) as Record<string, number>
const projectStats = (w: { store: Map<string, unknown> }, root: string) =>
  (w.store.get(`project:${root}`) as { stats: Record<string, number> } | undefined)?.stats

const start = ($: any, w: { root: string }) => $.session.start({ cwd: w.root, surface: null, isInteractive: false })

test('each turn is scored on its own prompt, and continuations keep the last level', async ($, on) => {
  const w = world(on, (p) => (p === 'hard' ? 3 : 0))
  await start($, w)
  // Two prompts started before either steps: each must reach its own turn.
  await $.turn.start({ turnId: 't1', text: 'easy' })
  await $.turn.start({ turnId: 't2', text: '<system-reminder>x</system-reminder>hard' })
  await steps($, 't1')
  await complete($, 't1')
  await steps($, 't2')
  await complete($, 't2')
  await turn($, 't3', '')
  expect(w.asked).toEqual(['easy', 'hard'])
  expect(w.effort.get('t1')).toBe('low')
  expect(w.effort.get('t2')).toBe('xhigh')
  expect(w.effort.get('t3')).toBe('xhigh')
})

test('a subagent hand-back is not scored and keeps the last level', async ($, on) => {
  const w = world(on, (p) => (p === 'easy' ? 0 : 3))
  await start($, w)
  // Before any level is known, an unprompted turn leaves the session's effort alone.
  await turn($, 'h0', '')
  await turn($, 'h1', 'easy')
  await turn($, 'h2', '<agent-message from="a1">\nThe report follows:\n  hi\n</agent-message>\n\nThat is an agent.')
  expect(w.asked).toEqual(['easy'])
  expect(w.effort.get('h0')).toBe('high')
  expect(w.effort.get('h2')).toBe('low')
})

test('without a first-party credential (Bedrock, Vertex, a gateway) Jev is never called', async ($, on) => {
  const w = world(on, () => 3)
  w.firstParty = false
  await start($, w)
  await turn($, 'g1', 'hard')
  expect(w.asked).toEqual([])
  expect(w.effort.get('g1')).toBe('high')
})

test('a cache rebuild is read from the first request of a turn, not its total', async ($, on) => {
  const w = world(on, (p) => (p === 'hard' ? 3 : 0))
  await start($, w)
  await turn($, 'r1', 'easy')
  const before = overall(w).rebuiltTokens ?? 0
  // Level changes, but the first request wrote little: the large total is tool results.
  await turn($, 'r2', 'hard')
  expect(overall(w).rebuiltTokens).toBe(before)
  // Level changes and the first request rewrote the conversation: that is the rebuild.
  w.firstWrite = 22000
  await turn($, 'r3', 'easy')
  expect(overall(w).rebuiltTokens).toBe(before + 22000)
})

test('totals are kept per project by full path, and reset clears this project only', async ($, on) => {
  const w = world(on, () => 0)
  await start($, w)
  await turn($, 'p1', 'easy')
  const applied = overall(w).applied ?? 0
  w.root = '/Users/a/Work/alpha'
  await turn($, 'p2', 'easy')
  expect(projectStats(w, '/Users/a/Dev/alpha')?.applied).toBe(1)
  expect(projectStats(w, '/Users/a/Work/alpha')?.applied).toBe(1)
  expect(overall(w).applied).toBe(applied + 1)

  const shown = await $.command.run({ command: 'jeffort', args: 'stats' })
  expect(shown.text).toContain('This project (alpha): 1 of 1 turns')
  expect(shown.text).toContain('All projects')

  await $.command.run({ command: 'jeffort', args: 'reset' })
  expect(projectStats(w, '/Users/a/Work/alpha')?.applied).toBe(0)
  expect(projectStats(w, '/Users/a/Dev/alpha')?.applied).toBe(1)
  expect(overall(w).applied).toBe(applied + 1)

  await $.command.run({ command: 'jeffort', args: 'reset all' })
  expect(projectStats(w, '/Users/a/Dev/alpha')).toBeUndefined()
  expect(overall(w).applied).toBe(0)
})

/** One subagent turn: its steps at `effort` (what it inherited or its definition set) and its completion. */
async function agentTurn($: any, agentId: string, turnId: string, effort = 'high') {
  for (let index = 0; index < STEPS_PER_TURN; index++) {
    const s = $.turn.step({ turnId, index, model: MODEL, effort, messageCount: 1, agentId })
    for await (const _ of s) void _
    await s.result
  }
  // A fresh conversation: its first request writes a large cache, which is no rebuild.
  await $.turn.complete({ turnId, agentId, answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: usage(1000, 30000) })
}

test('a subagent is scored once on its task and counted, never as a rebuild', async ($, on) => {
  const w = world(on, (p) => (p === 'find the config' ? 0 : 3))
  w.agents.push({ id: 'a1', type: 'Explore', task: 'find the config' })
  await start($, w)
  await turn($, 'm1', 'hard')
  const before = overall(w)
  await agentTurn($, 'a1', 's1')
  await agentTurn($, 'a1', 's2')
  expect(w.asked).toEqual(['hard', 'find the config'])
  expect(w.effort.get('a1/s1')).toBe('low')
  expect(w.effort.get('a1/s2')).toBe('low')
  expect(overall(w).applied).toBe((before.applied ?? 0) + 2)
  expect(overall(w).rebuiltTokens).toBe(before.rebuiltTokens ?? 0)
})

test('with only-lower on, Jeffort drops effort for quick questions but never raises it', { options: { ceiling: 'max', onlyLower: true } }, async ($, on) => {
  const w = world(on, (p) => (p.startsWith('hard') ? 3 : 0))
  w.agents.push({ id: 'a1', type: 'implementer', task: 'hard: fix the race' })
  await start($, w)
  await turn($, 'l1', 'hard: redesign the storage engine')
  await turn($, 'l2', 'what does this flag do?')
  await agentTurn($, 'a1', 's1')
  expect(w.effort.get('l1')).toBe('high')
  expect(w.effort.get('l2')).toBe('low')
  expect(w.effort.get('a1/s1')).toBe('high')
})

test('a subagent goes at most one level above the effort it inherited, by default', { options: { ceiling: 'max' } }, async ($, on) => {
  const w = world(on, () => 3)
  w.agents.push({ id: 'a1', type: 'implementer', task: 'fix the blocking review' })
  await start($, w)
  await turn($, 'm1', 'hard')
  await agentTurn($, 'a1', 's1')
  expect(w.effort.get('m1')).toBe('max')
  expect(w.effort.get('a1/s1')).toBe('xhigh')
})

test('the subagent ceiling can match the session\'s, or be a fixed level', { options: { ceiling: 'max', subagentCeiling: 'same' } }, async ($, on) => {
  const w = world(on, () => 3)
  w.agents.push({ id: 'a1', type: 'implementer', task: 'fix it' })
  await start($, w)
  await turn($, 'm1', 'hard')
  await agentTurn($, 'a1', 's1')
  expect(w.effort.get('a1/s1')).toBe('max')
})

test('a fixed subagent ceiling caps every subagent', { options: { subagentCeiling: 'medium' } }, async ($, on) => {
  const w = world(on, () => 3)
  w.agents.push({ id: 'a1', type: 'codex-reviewer', task: 're-review the PR' })
  await start($, w)
  await turn($, 'm1', 'hard')
  await agentTurn($, 'a1', 's1')
  expect(w.effort.get('m1')).toBe('xhigh')
  expect(w.effort.get('a1/s1')).toBe('medium')
})

test('a background task\'s notice is not scored and keeps the last level', async ($, on) => {
  const w = world(on, (p) => (p === 'hard' ? 3 : 0))
  await start($, w)
  await turn($, 'n1', 'hard')
  await turn($, 'n2', '<task-notification> <task-id>b1g6ot29j</task-id> done </task-notification>')
  expect(w.asked).toEqual(['hard'])
  expect(w.effort.get('n2')).toBe('xhigh')
})

test('a session with millions of output tokens still draws the band, in both bar styles', async ($, on) => {
  const w = world(on, () => 3)
  await start($, w)
  await $.turn.start({ turnId: 'x1', text: 'hard' })
  await steps($, 'x1')
  await $.turn.complete({ turnId: 'x1', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: usage(4_500_000, 500) })
  const band = () =>
    $.ui.mount({ plugin: 'jeffort', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, maxRows: 3, bodyColumns: 120 } })
  // Claude Code refuses the whole band if any flexGrow is above 10000.
  const grows = (tree: unknown): number[] =>
    JSON.stringify(tree).match(/"flexGrow":\d+/g)?.map((g) => Number(g.split(':')[1])) ?? []
  let ui = await band()
  expect(await ui.find({ key: 'open' })).toBeDefined()
  expect(Math.max(...grows(await ui.drawn()))).toBeLessThanOrEqual(1000)
  await ui.unmount()
  const pane = await $.ui.mount({ plugin: 'jeffort', surface: 'terminal', component: 'Pane', requestId: 'jeffort', props: {} } as any)
  await pane.press({ key: 'tab-look' })
  await pane.press({ key: 'bar-mix' })
  await pane.unmount()
  ui = await band()
  expect(await ui.find({ key: 'open' })).toBeDefined()
  await ui.unmount()
})

test('"go ahead" after a hard plan keeps the plan\'s level, and Jev sees the previous prompt', async ($, on) => {
  const w = world(on, (p) => (p.startsWith('design') ? 3 : 0))
  w.continues.add('yes, go ahead')
  await start($, w)
  await turn($, 'c1', 'design the storage engine compaction')
  await turn($, 'c2', 'yes, go ahead')
  expect(w.sentStates[1].previous_request).toBe('design the storage engine compaction')
  expect(w.effort.get('c2')).toBe('xhigh')
  await turn($, 'c3', 'what time is it')
  expect(w.effort.get('c3')).toBe('low')
})

test('prompts nobody typed are not scored, and keep the last level', async ($, on) => {
  const w = world(on, (p) => (p === 'hard' ? 3 : 0))
  await start($, w)
  await turn($, 'o1', 'hard')
  await $.prompt.submit({ text: 'Another Claude session sent a message', origin: { kind: 'peer' } } as any)
  await turn($, 'o2', 'Another Claude session sent a message')
  await $.prompt.submit({ text: 'easy', origin: { kind: 'composer' } } as any)
  await turn($, 'o3', 'easy')
  expect(w.asked).toEqual(['hard', 'easy'])
  expect(w.effort.get('o2')).toBe('xhigh')
  expect(w.effort.get('o3')).toBe('low')
})

test('secrets in a prompt never reach Jev', async ($, on) => {
  const w = world(on, () => 0)
  await start($, w)
  await turn($, 's1', 'rotate api_key=supersecret123 on https://prod.example.com')
  expect(w.asked[0]).not.toContain('supersecret123')
  expect(w.asked[0]).not.toContain('prod.example.com')
})

test('two cache losses after effort changes pause Jeffort until /jeffort on', async ($, on) => {
  const w = world(on, (p) => (p.startsWith('hard') ? 3 : 0))
  await start($, w)
  w.loseCache = true
  w.firstWrite = 30000
  await turn($, 'g1', 'hard one')
  await turn($, 'g2', 'easy one')
  await turn($, 'g3', 'hard two')
  expect(w.statuses.some((t) => /paused for this session/.test(t ?? ''))).toBe(true)
  await turn($, 'g4', 'easy two')
  expect(w.effort.get('g4')).toBe('high')
  await $.command.run({ command: 'jeffort', args: 'on' })
  w.loseCache = false
  await turn($, 'g5', 'easy three')
  expect(w.effort.get('g5')).toBe('low')
})

test('agreement reads yours = Jeffort\'s, and millions read as M', async ($, on) => {
  const w = world(on, () => 1.5)
  await start($, w)
  await turn($, 'q1', 'middling')
  const ui = await $.ui.mount({ plugin: 'jeffort', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, maxRows: 3, bodyColumns: 120 } })
  expect(textOf(await ui.drawn())).toContain('high = high')
  await ui.unmount()
  const big = async (output: number) => {
    await $.turn.start({ turnId: 'q2', text: 'hard enough' })
    await steps($, 'q2')
    await $.turn.complete({ turnId: 'q2', answer: '', durationMs: 1, isAborted: false, reason: 'answer', usage: usage(output, 500) })
  }
  await big(3_000_000)
  const shown = await $.command.run({ command: 'jeffort', args: 'stats' })
  expect(shown.text).not.toMatch(/\d{4,}\.\dk/)
})

test('subagents are left alone when their effort is their own, for forks, unknown loops, or when off', async ($, on) => {
  const w = world(on, () => 0)
  w.agents.push({ id: 'own', type: 'Plan', task: 'plan it' }, { id: 'fk', type: 'fork', task: 'go on' })
  await start($, w)
  await turn($, 'm1', 'easy')
  await agentTurn($, 'own', 's1', 'max')
  await agentTurn($, 'fk', 's2')
  await agentTurn($, 'compaction', 's3')
  expect(w.asked).toEqual(['easy'])
  expect(w.effort.get('own/s1')).toBe('max')
  expect(w.effort.get('fk/s2')).toBe('high')
  expect(w.effort.get('compaction/s3')).toBe('high')
})

test('the subagents setting off leaves every subagent alone', { options: { subagents: false } }, async ($, on) => {
  const w = world(on, () => 0)
  w.agents.push({ id: 'a1', type: 'Explore', task: 'find the config' })
  await start($, w)
  await turn($, 'm1', 'easy')
  await agentTurn($, 'a1', 's1')
  expect(w.asked).toEqual(['easy'])
  expect(w.effort.get('a1/s1')).toBe('high')
})

const auditOverall = (w: { store: Map<string, unknown> }) =>
  ((w.store.get('jeffort') as { auditStats?: Record<string, number> } | undefined)?.auditStats ?? {}) as Record<string, number>
const auditProject = (w: { store: Map<string, unknown> }, root: string) =>
  (w.store.get(`project:${root}`) as { auditStats?: Record<string, number> } | undefined)?.auditStats
/** The words a drawn tree shows, its text nodes joined in order. */
const textOf = (node: unknown): string =>
  typeof node === 'string' ? node : Array.isArray((node as any)?.children) ? (node as any).children.map(textOf).join('') : ''

test('the status line carries warnings only, and a scored turn clears one', async ($, on) => {
  const w = world(on, (p) => (p === 'flaky' ? Number.NaN : 0))
  await start($, w)
  await turn($, 'w1', 'flaky')
  expect(w.statuses.at(-1)).toMatch(/kept high/)
  await turn($, 'w2', 'easy')
  expect(w.statuses.at(-1)).toBeUndefined()
  await turn($, 'w3', 'easy')
  expect(w.statuses.length).toBe(2)
})

test('a drop reads pick ← yours, a boost yours → pick, and the band counts tokens, never dollars', async ($, on) => {
  const w = world(on, (p) => (p === 'hard' ? 3 : 0))
  await start($, w)
  const band = (bodyColumns = 120) =>
    $.ui.mount({ plugin: 'jeffort', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, maxRows: 3, bodyColumns } })

  await turn($, 'e1', 'easy')
  let ui = await band()
  let drawn = JSON.stringify(await ui.drawn())
  expect(textOf(await ui.drawn())).toContain('low ← high')
  expect(drawn).not.toContain('→')
  expect(await ui.find({ type: 'Text', text: /saved/ })).toBeDefined()
  expect(drawn).not.toContain('$')
  expect(drawn).toContain('backgroundColor')
  await ui.unmount()

  await turn($, 'e2', 'hard')
  await turn($, 'e3', 'hard')
  ui = await band()
  drawn = JSON.stringify(await ui.drawn())
  expect(textOf(await ui.drawn())).toContain('high → xhigh')
  expect(drawn).toContain('"bold":true')
  expect(await ui.find({ type: 'Text', text: /extra/ })).toBeDefined()
  await ui.unmount()

  // Too narrow for the bar: the figure alone carries it.
  ui = await band(50)
  expect(JSON.stringify(await ui.drawn())).not.toContain('backgroundColor')
  await ui.unmount()
})

test('audit mode scores every turn but never changes effort, and keeps its own totals', async ($, on) => {
  const w = world(on, (p) => (p === 'hard' ? 3 : 0))
  await start($, w)
  await $.command.run({ command: 'jeffort', args: 'audit' })
  await turn($, 'a1', 'easy')
  await turn($, 'a2', 'hard')
  await turn($, 'a3', '')
  expect(w.asked).toEqual(['easy', 'hard'])
  for (const id of ['a1', 'a2', 'a3']) expect(w.effort.get(id)).toBe('high')
  // Live totals untouched; audit totals under the main key and the project, never a rebuild.
  expect(overall(w).applied ?? 0).toBe(0)
  expect(auditOverall(w).applied).toBe(3)
  expect(auditOverall(w).rebuiltTokens).toBe(0)
  expect(auditProject(w, w.root)?.applied).toBe(3)
  // easy at low would save on 1000 tokens run at high; hard at xhigh twice would spend more.
  expect(auditOverall(w).tokensSaved).toBe(450 - 700 - 700)
  const shown = await $.command.run({ command: 'jeffort', args: 'stats' })
  expect(shown.text).toMatch(/auditing only/)
  expect(shown.text).toMatch(/would have changed 3 of 3 turns/)
})

test('audit mode runs where setting effort would lose the cache', async ($, on) => {
  const w = world(on, () => 3)
  w.firstParty = false
  await start($, w)
  await $.command.run({ command: 'jeffort', args: 'audit' })
  await turn($, 'b1', 'hard')
  expect(w.asked).toEqual(['hard'])
  expect(w.effort.get('b1')).toBe('high')
  expect(auditOverall(w).applied).toBe(1)
})

test('switching from audit to on counts each turn in its own mode, and reset clears both', async ($, on) => {
  const w = world(on, (p) => (p === 'hard' ? 3 : 0))
  await start($, w)
  await $.command.run({ command: 'jeffort', args: 'audit' })
  await turn($, 'c1', 'hard')
  await $.command.run({ command: 'jeffort', args: 'on' })
  await turn($, 'c2', 'easy')
  expect(w.effort.get('c1')).toBe('high')
  expect(w.effort.get('c2')).toBe('low')
  expect(auditOverall(w).applied).toBe(1)
  expect(overall(w).applied).toBe(1)
  // The first live change after audit is measured against the effort that actually ran (high).
  expect(overall(w).changed).toBe(1)
  await $.command.run({ command: 'jeffort', args: 'reset all' })
  expect(auditOverall(w).applied).toBe(0)
  expect(overall(w).applied).toBe(0)
  expect(auditProject(w, w.root)?.applied ?? 0).toBe(0)
})

test('the band and status line say what audit mode would pick', async ($, on) => {
  const w = world(on, () => 3)
  await start($, w)
  await $.command.run({ command: 'jeffort', args: 'audit' })
  await turn($, 'd1', 'hard')
  const ui = await $.ui.mount({ plugin: 'jeffort', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, maxRows: 3, bodyColumns: 120 } })
  const drawn = JSON.stringify(await ui.drawn())
  expect(textOf(await ui.drawn())).toContain('audit ·')
  expect(textOf(await ui.drawn())).toContain('high → would pick xhigh')
  expect(await ui.find({ type: 'Text', text: /extra/ })).toBeDefined()
  await ui.unmount()
})

