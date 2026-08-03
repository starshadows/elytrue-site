import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { nextTick } from 'vue'
import {
  createAuthStore,
  type UserProfile,
} from '../../src/features/auth/auth-store'
import { resolveThemeSelection } from '../../src/features/theme/theme-controller'

const profile: UserProfile = {
  id: 'user-1',
  name: 'Elysia',
  avatar: 'elysia.webp',
}

describe('auth feature state', () => {
  test('initialization is single-flight and updates reactive identity state', async () => {
    let loads = 0
    let resolveProfile: ((value: UserProfile) => void) | undefined
    const pendingProfile = new Promise<UserProfile>((resolve) => {
      resolveProfile = resolve
    })
    const store = createAuthStore({
      clearSession() {},
      loadProfile() {
        loads += 1
        return pendingProfile
      },
    })

    const first = store.initialize()
    const second = store.initialize()

    assert.equal(first, second)
    assert.equal(loads, 1)
    assert.equal(store.state.loginState, 'loading')
    resolveProfile?.(profile)
    assert.deepEqual(await first, profile)
    await nextTick()
    assert.equal(store.authenticated.value, true)
    assert.equal(store.state.loginState, 'authenticated')
    assert.equal(store.state.userId, profile.id)
    assert.deepEqual(store.state.profile, profile)
  })

  test('failed refresh clears session and session invalidation is immediate', async () => {
    let shouldFail = false
    let clears = 0
    const store = createAuthStore({
      clearSession() {
        clears += 1
      },
      async loadProfile() {
        if (shouldFail) throw new Error('expired')
        return profile
      },
    })

    await store.initialize()
    shouldFail = true
    assert.equal(await store.refresh(), null)
    assert.equal(clears, 1)
    assert.equal(store.authenticated.value, false)
    assert.equal(store.state.loginState, 'unauthenticated')
    assert.equal(store.state.userId, null)
    assert.equal(store.state.profile, null)
  })

  test('a stale initialization cannot overwrite a newer refresh', async () => {
    const resolvers: Array<(value: UserProfile) => void> = []
    const store = createAuthStore({
      clearSession() {},
      loadProfile() {
        return new Promise<UserProfile>((resolve) => resolvers.push(resolve))
      },
    })

    const stale = store.initialize()
    const current = store.refresh()
    resolvers[1]?.({ ...profile, id: 'new-user' })
    await current
    resolvers[0]?.({ ...profile, id: 'old-user' })
    await stale

    assert.equal(store.state.userId, 'new-user')
    assert.equal(store.state.profile?.id, 'new-user')
  })
})

test('an empty automatic theme selection resolves to the current auto theme', () => {
  assert.equal(resolveThemeSelection('', 'default'), 'default')
  assert.equal(resolveThemeSelection(undefined, 'default'), 'default')
  assert.equal(resolveThemeSelection('default', 'other'), 'default')
})
