import assert from 'node:assert/strict'
import { test } from 'node:test'
import Settings, {
  backgroundCaptionsHiddenFromConfig,
} from '../../src/settings'

test('background captions default hidden and persist explicit changes', () => {
  assert.equal(backgroundCaptionsHiddenFromConfig(null), true)
  assert.equal(backgroundCaptionsHiddenFromConfig(''), true)
  assert.equal(backgroundCaptionsHiddenFromConfig('true'), true)
  assert.equal(backgroundCaptionsHiddenFromConfig('false'), false)

  const values = new Map<string, string>()
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      removeItem: (key: string) => values.delete(key),
      setItem: (key: string, value: string) => values.set(key, value),
    },
  })

  try {
    Settings.hideBackgroundCaptions = false
    assert.equal(Settings.hideBackgroundCaptions, false)
    assert.equal(values.get('hideBackgroundCaptions'), 'false')
    Settings.hideBackgroundCaptions = true
    assert.equal(Settings.hideBackgroundCaptions, true)
    assert.equal(values.get('hideBackgroundCaptions'), 'true')
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
