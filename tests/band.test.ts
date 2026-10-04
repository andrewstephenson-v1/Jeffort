import type { On } from 'claude-code'
import { expect, test } from 'claude-code/testing'

// The harness has no store beneath the plugin; answer it from memory.
function memoryStore(on: On) {
  const store = new Map<string, unknown>()
  on('store.get', async (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', async (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
}

const BAND = { component: 'AbovePrompt', props: { hasSurvey: false } } as const

test('the band is one row with a Jeffort button on every surface, and no toggle of its own', async ($, on) => {
  memoryStore(on)
  for (const surface of ['terminal', 'desktop', 'vscode'] as const) {
    const ui = await $.ui.mount({ plugin: 'jeffort', surface, ...BAND })
    expect((await ui.find({ key: 'open' }))?.text).toBe('Jeffort')
    expect(await ui.find({ key: 'toggle' })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /waiting for a turn/ })).toBeDefined()
    await ui.unmount()
  }
})

test('the band keeps what other plugins drew, beneath its own row', async ($, on) => {
  memoryStore(on)
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['[ build ] main · 3 checks passing'] }) as any)
  const ui = await $.ui.mount({ plugin: 'jeffort', surface: 'terminal', ...BAND })
  const drawn = JSON.stringify(await ui.drawn())
  expect(drawn).toContain('[ build ] main · 3 checks passing')
  expect(drawn.indexOf('Jeffort')).toBeLessThan(drawn.indexOf('[ build ]'))
  await ui.unmount()
})

test('the band steps aside for a survey', async ($, on) => {
  memoryStore(on)
  on('ui.render', async () => ({ type: 'Text', props: {}, children: ['How is Claude doing this session?'] }) as any)
  const ui = await $.ui.mount({ plugin: 'jeffort', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: true } })
  expect(await ui.find({ key: 'open' })).toBeUndefined()
  expect(JSON.stringify(await ui.drawn())).toContain('How is Claude doing')
  await ui.unmount()
})
