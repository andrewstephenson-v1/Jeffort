import { test, expect } from 'claude-code/testing'

import { allowedLevels, buildRequest, cleanPrompt, decide, isCacheSafeModel } from '../hooks/policy'

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
  const req = buildRequest('plan a trip to Japan') as {
    state: unknown
    questions: Record<string, { type: string; criteria: string[] }>
  }
  expect(req.state).toEqual({ request: 'plan a trip to Japan' })
  expect(Object.keys(req.questions)).toEqual(['depth', 'scope', 'stakes', 'ambiguity'])
  for (const q of Object.values(req.questions)) {
    expect(q.type).toBe('score')
    expect(q.criteria.length).toBe(4)
  }
})

test('system reminders are stripped from the prompt', () => {
  expect(cleanPrompt('<system-reminder>x</system-reminder>\nhello')).toBe('hello')
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
