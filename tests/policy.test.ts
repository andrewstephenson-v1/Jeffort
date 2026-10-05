import { test, expect } from 'claude-code/testing'

import { allowedLevels, assistantOf, buildRequest, cleanPrompt, decide, isCacheSafeModel, isSupportedVersion } from '../hooks/policy'

const dims = (score: number, confidence: number) => ({
  answers: Object.fromEntries(['depth', 'scope', 'stakes', 'ambiguity'].map((d) => [d, { score, confidence }])),
})

test('only cache-safe models are touched', () => {
  expect(isCacheSafeModel('claude-opus-5-5')).toBe(true)
  expect(isCacheSafeModel('claude-sonnet-5-5')).toBe(true)
  expect(isCacheSafeModel('claude-fable-5-1')).toBe(true)
  expect(isCacheSafeModel('claude-opus-5')).toBe(false)
  expect(isCacheSafeModel('claude-haiku-4-5-20251001')).toBe(false)
})

test('only Claude Code 2.1.284 or later is supported', () => {
  expect(isSupportedVersion('2.1.284')).toBe(true)
  expect(isSupportedVersion('2.1.288-dev')).toBe(true)
  expect(isSupportedVersion('2.2.0')).toBe(true)
  expect(isSupportedVersion('2.1.283')).toBe(false)
  expect(isSupportedVersion('1.9.999')).toBe(false)
  expect(isSupportedVersion(undefined)).toBe(false)
  expect(isSupportedVersion('nightly')).toBe(false)
})

test('Jev is told which model answers, with a description where we have one', () => {
  expect(assistantOf('claude-opus-5-5[1m]').name).toBe('Claude Opus 5.5')
  expect(assistantOf('claude-sonnet-5-5').description).toContain('less capable than Opus')
  expect(assistantOf('claude-unknown')).toEqual({ name: 'claude-unknown' })
})

test('levels run floor to ceiling and tolerate bad input', () => {
  expect(allowedLevels('low', 'xhigh')).toEqual(['low', 'medium', 'high', 'xhigh'])
  expect(allowedLevels('medium', 'high')).toEqual(['medium', 'high'])
  expect(allowedLevels('max', 'low')).toEqual(['low', 'medium', 'high', 'xhigh', 'max'])
  expect(allowedLevels(undefined, 'nonsense')).toEqual(['low', 'medium', 'high', 'xhigh'])
})

test('composite maps linearly onto the allowed levels', () => {
  const levels = allowedLevels('low', 'xhigh')
  expect(decide(dims(0, 0.9), levels)).toMatchObject({ level: 'low' })
  expect(decide(dims(1.5, 0.9), levels)).toMatchObject({ level: 'high' })
  expect(decide(dims(3, 0.9), levels)).toMatchObject({ level: 'xhigh' })
  expect(decide(dims(9, 0.9), levels)).toMatchObject({ level: 'xhigh' })
  expect(decide(dims(1, 0.6), levels)).toMatchObject({ confidences: { depth: 0.6, scope: 0.6, stakes: 0.6, ambiguity: 0.6 } })
})

test('depth carries the most weight', () => {
  const levels = allowedLevels('low', 'xhigh')
  const only = (d: string) => ({
    answers: Object.fromEntries(
      ['depth', 'scope', 'stakes', 'ambiguity'].map((k) => [k, { score: k === d ? 3 : 0, confidence: 0.9 }]),
    ),
  })
  const depth = decide(only('depth'), levels)
  const ambiguity = decide(only('ambiguity'), levels)
  expect(depth.level && ambiguity.level && levels.indexOf(depth.level) > levels.indexOf(ambiguity.level)).toBe(true)
})

test('low confidence or a missing dimension keeps the session effort', () => {
  const levels = allowedLevels('low', 'xhigh')
  expect(decide(dims(2, 0.1), levels)).toEqual({ level: null, reason: 'low-confidence' })
  expect(decide({}, levels)).toEqual({ level: null, reason: 'no-answer' })
  expect(decide(null, levels)).toEqual({ level: null, reason: 'no-answer' })
  const partial = { answers: { depth: { score: 2, confidence: 0.9 } } }
  expect(decide(partial, levels)).toEqual({ level: null, reason: 'no-answer' })
})

test('request sends only the prompt and four narrow questions', () => {
  const req = buildRequest('plan a trip to Japan', 'claude-sonnet-5-5') as {
    state: { request: string; assistant: { name: string } }
    questions: Record<string, { type: string; criteria: string[] }>
  }
  expect(Object.keys(req.state)).toEqual(['request', 'assistant'])
  expect(req.state.request).toBe('plan a trip to Japan')
  expect(req.state.assistant.name).toBe('Claude Sonnet 5.5')
  expect(Object.keys(req.questions)).toEqual(['depth', 'scope', 'stakes', 'ambiguity'])
  for (const q of Object.values(req.questions)) {
    expect(q.type).toBe('score')
    expect(q.criteria.length).toBe(4)
  }
})

test('system reminders are stripped from the prompt', () => {
  expect(cleanPrompt('<system-reminder>x</system-reminder>\nhello')).toBe('hello')
})

test('a subagent hand-back is not a prompt', () => {
  const handback =
    'Another Claude session sent a message:\n<agent-message from="a362ec11c8108b6b8">\n[Subagent hand-back] The ' +
    'report follows:\n  hi\n</agent-message>\n\nThat "other Claude session" is an agent working inside this same ' +
    "session, so this was not typed by your user. That's permission laundering."
  expect(cleanPrompt('<task-notification> <task-id>b1</task-id> done </task-notification>')).toBe('')
  expect(cleanPrompt(handback)).toBe('')
  expect(cleanPrompt(`<system-reminder>x</system-reminder>${handback}`)).toBe('')
})

import { barModel, estimateSaved, outputPrice, parseEnv, shares } from '../hooks/policy'

test('savings estimate: lower level than baseline saves, higher spends', () => {
  expect(estimateSaved(550, 'low', 'high')).toBe(450)
  expect(estimateSaved(1000, 'high', 'high')).toBe(0)
  expect(estimateSaved(1000, 'xhigh', 'high')).toBeLessThan(0)
})

test('output price known only for the 5.5 models', () => {
  expect(outputPrice('claude-opus-5-5')).toBe(20)
  expect(outputPrice('claude-sonnet-5-5')).toBe(10)
  expect(outputPrice('claude-fable-5-1')).toBeUndefined()
})

test('parseEnv reads plain, quoted and commented lines', () => {
  const v = parseEnv('# c\nJEV_API_KEY="abc"\nexport X=1\n\nBAD LINE\n')
  expect(v).toEqual({ JEV_API_KEY: 'abc', X: '1' })
})

test('bar: saving adds a segment, overspend is shown separately', () => {
  expect(barModel(307, 549)).toEqual({ used: 307, saved: 549, over: 0 })
  expect(barModel(400, -100)).toEqual({ used: 300, saved: 0, over: 100 })
  expect(barModel(0, 0)).toEqual({ used: 0, saved: 0, over: 0 })
})

test('shares are whole percentages that always sum to 100', () => {
  expect(shares({ low: 5, medium: 3, high: 3, xhigh: 0, max: 0 })).toEqual({ low: 46, medium: 27, high: 27, xhigh: 0, max: 0 })
  expect(shares({ low: 1, medium: 1, high: 1, xhigh: 0, max: 0 })).toEqual({ low: 34, medium: 33, high: 33, xhigh: 0, max: 0 })
  expect(shares({ low: 0, medium: 0, high: 0, xhigh: 0, max: 0 })).toEqual({ low: 0, medium: 0, high: 0, xhigh: 0, max: 0 })
  const sum = Object.values(shares({ low: 7, medium: 2, high: 9, xhigh: 4, max: 1 })).reduce((a, b) => a + b, 0)
  expect(sum).toBe(100)
})

import { CacheCheck, buildRequest as request, capLevel, continuesPrevious, estimateWouldSave, grow, initialMode, projectKey, projectName, subagentCap } from '../hooks/policy'

test('the enabled setting set to false wins over the stored mode, and an old toggle still counts', () => {
  expect(initialMode('on', true, false)).toBe('off')
  expect(initialMode('audit', undefined, false)).toBe('off')
  expect(initialMode(undefined, undefined, false)).toBe('off')
  expect(initialMode('audit', undefined, true)).toBe('audit')
  expect(initialMode('off', undefined, undefined)).toBe('off')
  expect(initialMode(undefined, false, true)).toBe('off')
  expect(initialMode(undefined, true, undefined)).toBe('on')
  expect(initialMode(undefined, undefined, undefined)).toBe('on')
  expect(initialMode('loud', 'yes', true)).toBe('on')
})

test('audit estimates run from the measured level to the pick, live ones the other way', () => {
  // 1000 tokens measured at high; picking low would have produced 550, so 450 saved.
  expect(estimateWouldSave(1000, 'high', 'low')).toBe(450)
  // 1000 tokens measured at high; picking xhigh would have produced 1700, so 700 more.
  expect(estimateWouldSave(1000, 'high', 'xhigh')).toBe(-700)
  expect(estimateWouldSave(1000, 'medium', 'medium')).toBe(0)
  // Live: 550 tokens measured at low, against a high baseline that would have produced 1000.
  expect(estimateSaved(550, 'low', 'high')).toBe(450)
})

test('projects are keyed by full path and named by their last segment', () => {
  expect(projectKey('/Users/a/Dev/api')).not.toBe(projectKey('/Users/a/Work/api'))
  expect(projectName('/Users/a/Dev/ClaudeMods/Jeffort')).toBe('Jeffort')
  expect(projectName('/Users/a/Dev/api/')).toBe('api')
  expect(projectName('C:\\Users\\a\\Dev\\api')).toBe('api')
  expect(projectName('/')).toBe('/')
})

test('the subagent cap is one above the inherited effort by default, within the allowed levels', () => {
  const all = ['low', 'medium', 'high', 'xhigh', 'max'] as const
  expect(subagentCap('one-above', 'medium', all)).toBe('high')
  expect(subagentCap(undefined, 'medium', all)).toBe('high')
  expect(subagentCap('one-above', 'max', all)).toBe('max')
  expect(subagentCap('same', 'medium', all)).toBe('max')
  expect(subagentCap('low', 'high', ['medium', 'high', 'xhigh'])).toBe('medium')
  expect(subagentCap('max', 'high', ['low', 'medium', 'high', 'xhigh'])).toBe('xhigh')
  expect(capLevel('xhigh', 'high')).toBe('high')
  expect(capLevel('low', 'high')).toBe('low')
})

test('bar weights stay on a 0-1000 scale whatever the token counts', () => {
  expect(grow(4_478_700, 10_014_600)).toBe(447)
  expect(grow(1, 10_000_000)).toBe(1)
  expect(grow(0, 100)).toBe(0)
  expect(grow(5, 0)).toBe(0)
  expect(grow(200, 100)).toBe(1000)
})

test('the previous prompt and the continuation question go to Jev only when there was one', () => {
  expect(request('fix it', 'claude-opus-5-5').questions).not.toHaveProperty('continues_previous')
  const r = request('yes, go ahead', 'claude-opus-5-5', 'jev-latest', 'x'.repeat(2000))
  expect(r.questions).toHaveProperty('continues_previous')
  expect((r.state as { previous_request: string }).previous_request).toHaveLength(1500)
  expect(continuesPrevious({ answers: { continues_previous: { type: 'noul', noul: 0.9 } } })).toBe(0.9)
  expect(continuesPrevious({ answers: {} })).toBeUndefined()
})

test('the cache check pauses after two losses in a row, and a kept cache clears the count', () => {
  const c = new CacheCheck()
  const at = (t: number, effort: string, read: number, written: number) => ({ at: t, model: 'm', effort, read, written })
  expect(c.see(at(0, 'high', 0, 40000))).toBe('fine')
  expect(c.see(at(1, 'low', 0, 40000))).toBe('lost')
  expect(c.see(at(2, 'high', 40000, 500))).toBe('fine')
  expect(c.see(at(3, 'low', 0, 40500))).toBe('lost')
  expect(c.see(at(4, 'high', 0, 40500))).toBe('pause')
  // Same effort, or minutes apart (the cache may have expired): never counted.
  const d = new CacheCheck()
  d.see(at(0, 'high', 0, 40000))
  expect(d.see(at(1, 'high', 0, 40000))).toBe('fine')
  expect(d.see(at(10 * 60_000, 'low', 0, 40000))).toBe('fine')
})
