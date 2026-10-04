import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

import { DEFAULT_THEME, THEMES, THEME_IDS, isTheme, levelColor, mix, paletteOf } from '../hooks/policy'

// The harness has no store beneath the plugin; answer it from memory.
function memoryStore(on: On) {
  const store = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
}

const PANE = { component: 'Pane', props: {}, requestId: 'jeffort' } as const

test('every theme defines every colour, and extra spend differs from savings', () => {
  const keys = ['used', 'saved', 'over', 'rebuild', 'low', 'medium', 'high', 'xhigh', 'max'] as const
  for (const id of THEME_IDS) {
    const p = THEMES[id]!.palette
    for (const k of keys) expect(typeof p[k]).toBe('string')
    expect(p.over).not.toBe(p.saved)
    expect(p.used).not.toBe(p.saved)
  }
})

test('unknown themes fall back to the default palette', () => {
  expect(isTheme('retro')).toBe(true)
  expect(isTheme('nope')).toBe(false)
  expect(paletteOf('nope')).toEqual(THEMES[DEFAULT_THEME]!.palette)
  expect(levelColor(paletteOf('default'), 'high')).toBe(THEMES.default!.palette.high)
  expect(levelColor(paletteOf('default'), 'bogus')).toBe(THEMES.default!.palette.used)
})

test('mix counts levels and ignores unknown ones', () => {
  expect(mix(['low', 'low', 'high', 'weird'])).toEqual({ low: 2, medium: 0, high: 1, xhigh: 0, max: 0 })
})

test('pane has both tabs and every theme on every surface', async ($, on) => {
  memoryStore(on)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'jeffort', surface, ...PANE })
    expect(await ui.find({ key: 'tab-stats' })).toBeDefined()
    expect(await ui.find({ key: 'tab-look' })).toBeDefined()
    await ui.press({ key: 'tab-look' })
    for (const id of THEME_IDS) expect(await ui.find({ key: `theme-${id}` })).toBeDefined()
    await ui.press({ key: 'theme-retro' })
    expect((await ui.find({ key: 'theme-retro' }))?.text).toContain('●')
    for (const id of ['savings', 'mix']) expect(await ui.find({ key: `bar-${id}` })).toBeDefined()
    await ui.press({ key: 'bar-mix' })
    expect((await ui.find({ key: 'bar-mix' }))?.text).toContain('●')
    await ui.press({ key: 'tab-stats' })
    expect(await ui.find({ type: 'Text', text: /No turns scored yet/ })).toBeDefined()
    for (const id of ['on', 'audit', 'off']) expect(await ui.find({ key: `mode-${id}` })).toBeDefined()
    await ui.press({ key: 'mode-audit' })
    expect((await ui.find({ key: 'mode-audit' }))?.text).toContain('●')
    expect(await ui.find({ type: 'Text', text: /No turns audited yet/ })).toBeDefined()
    await ui.press({ key: 'mode-on' })
    await ui.unmount()
  }
})

test('band has a Jeffort button that opens the pane', async ($, on) => {
  memoryStore(on)
  let opened = false
  on('ui.open', async () => {
    opened = true
    return { value: { isPlaced: true } }
  })
  const ui = await $.ui.mount({ plugin: 'jeffort', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false } })
  expect((await ui.find({ key: 'open' }))?.text).toBe('Jeffort')
  await ui.press({ key: 'open' })
  expect(opened).toBe(true)
  await ui.unmount()
})
