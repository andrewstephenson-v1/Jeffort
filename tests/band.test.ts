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

test('band offers a toggle on every surface and flips it', async ($, on) => {
  memoryStore(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'jeffort', surface, ...BAND })
    expect(await ui.find({ key: 'toggle' })).toBeDefined()
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ key: 'toggle' }))?.text).toBe('Turn on')
    await ui.press({ key: 'toggle' })
    expect((await ui.find({ key: 'toggle' }))?.text).toBe('Turn off')
    await ui.unmount()
  }
})
