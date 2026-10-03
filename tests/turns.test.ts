import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

const MODEL = 'claude-opus-5-5'
const STEPS_PER_TURN = 2

type Usage = { model: string; input_tokens: number; output_tokens: number; cache_read_input_tokens: number; cache_creation_input_tokens: number }
const usage = (output: number, written: number): Usage => ({
  model: MODEL,
  input_tokens: 0,
  output_tokens: output,
  cache_read_input_tokens: 0,
  cache_creation_input_tokens: written,
})

/**
 * Everything beneath the plugin a turn touches: an in-memory store, a supported version, a project
 * root the test can move, an API key, Jev answering every dimension with the score `scoreOf` gives
 * the prompt, and a model whose first request writes `firstWrite` cache tokens and later ones 30k.
 */
function world(on: On, scoreOf: (prompt: string) => number) {
  const store = new Map<string, unknown>()
  const w = { store, root: '/Users/a/Dev/alpha', asked: [] as string[], effort: new Map<string, unknown>(), firstWrite: 500 }
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
  on('command.register', async () => ({ value: undefined }))
  on('ui.status', async () => ({ value: undefined }))
  on('session.version', async () => ({ value: { version: '2.1.290', base: '2.1.290' } }))
  on('session.root', async () => ({ value: w.root }))
  on('env.get', async (_$, e) => ({ value: e.name === 'TYPESAFE_API_KEY' ? 'test-key' : undefined }))
  on('fs.read', async () => ({ deny: 'no such file' }))
  on('clock.sleep', () => new Promise(() => {}))
  on('http.fetch', async (_$, e) => {
    const prompt = (JSON.parse(e.init?.body ?? '{}') as { state: { request: string } }).state.request
    w.asked.push(prompt)
    const answer = { score: scoreOf(prompt), confidence: 0.9 }
    const answers = Object.fromEntries(['depth', 'scope', 'stakes', 'ambiguity'].map((d) => [d, answer]))
    return { value: { status: 200, ok: true, headers: {}, text: JSON.stringify({ answers }) } }
  })
  on('turn.step', async function* (_$, e) {
    if (e.index === 0) w.effort.set(e.turnId, e.effort)
    const u = usage(100, e.index === 0 ? w.firstWrite : 30000)
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

test('each turn is scored on its own prompt, and continuations are not scored', async ($, on) => {
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
  expect(w.effort.get('t3')).toBe('high')
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
