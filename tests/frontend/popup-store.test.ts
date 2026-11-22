import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { createPopupStore, SINGLETON_POPUPS } from '../../src/components/Popups'

function createHarness() {
  const callbacks = new Map<number, () => void>()
  const cancelled: number[] = []
  let nextTimer = 1
  const store = createPopupStore({
    cancelRemoval(handle) {
      const timer = handle as number
      cancelled.push(timer)
      callbacks.delete(timer)
    },
    scheduleRemoval(callback) {
      const timer = nextTimer++
      callbacks.set(timer, callback)
      return timer
    },
  })
  return {
    callbacks,
    cancelled,
    runTimer(timer: number) {
      const callback = callbacks.get(timer)
      callbacks.delete(timer)
      callback?.()
    },
    store,
  }
}

describe('popup store', () => {
  test('the explicit singleton list reuses, reopens, updates, and raises entries', () => {
    assert.deepEqual(SINGLETON_POPUPS, [
      'displaySettings',
      'getImgPopup',
      'themeSelectorPopup',
    ])
    const { callbacks, cancelled, store } = createHarness()
    const gallery = store.show('getImgPopup', { source: 'first' })
    const settings = store.show('displaySettings')
    store.close(gallery)
    assert.equal(store.popups[0]?.closing, true)
    assert.equal(callbacks.size, 1)

    const reopened = store.show('getImgPopup', { source: 'second' })
    assert.equal(reopened, gallery)
    assert.equal(store.popups.length, 2)
    assert.equal(store.topmost()?.id, gallery)
    assert.equal(store.topmost()?.closing, false)
    assert.deepEqual(store.topmost()?.props, { source: 'second' })
    assert.deepEqual(cancelled, [1])
    assert.equal(callbacks.size, 0)
    assert.equal(
      store.popups.some((item) => item.id === settings),
      true,
    )
  })

  test('bringToFront moves an existing popup to the top of the stack', () => {
    const { store } = createHarness()
    const theme = store.show('themeSelectorPopup')
    const settings = store.show('displaySettings')
    assert.equal(store.topmost()?.id, settings)

    store.bringToFront(theme)
    assert.deepEqual(
      store.popups.map((item) => item.id),
      [settings, theme],
    )
    assert.equal(store.topmost()?.id, theme)
  })

  test('close marks only the top layer closing and removes it after animation', () => {
    const { callbacks, runTimer, store } = createHarness()
    const theme = store.show('themeSelectorPopup')
    const gallery = store.show('getImgPopup')

    store.close()
    assert.equal(
      store.popups.find((item) => item.id === gallery)?.closing,
      true,
    )
    assert.equal(store.popups.find((item) => item.id === theme)?.closing, false)
    assert.equal(store.topmost()?.id, theme)
    assert.equal(callbacks.size, 1)

    runTimer(1)
    assert.deepEqual(
      store.popups.map((item) => item.id),
      [theme],
    )
  })

  test('replace cancels closing without changing identity or stack position', () => {
    const { callbacks, cancelled, store } = createHarness()
    const first = store.show('displaySettings')
    const second = store.show('themeSelectorPopup')
    store.close(first)

    store.replace(first, 'getImgPopup', { reason: 'gallery' })
    assert.deepEqual(
      store.popups.map((item) => item.id),
      [first, second],
    )
    assert.equal(store.popups[0]?.name, 'getImgPopup')
    assert.equal(store.popups[0]?.closing, false)
    assert.deepEqual(store.popups[0]?.props, { reason: 'gallery' })
    assert.deepEqual(cancelled, [1])
    assert.equal(callbacks.size, 0)
  })
})
