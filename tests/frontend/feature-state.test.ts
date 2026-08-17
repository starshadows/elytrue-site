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
  uid: 1,
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

  test('transport failure preserves an authenticated profile and reports the error', async () => {
    let shouldFail = false
    let clears = 0
    let errors = 0
    const store = createAuthStore({
      clearSession() {
        clears += 1
      },
      async loadProfile() {
        if (shouldFail) throw new Error('expired')
        return profile
      },
      reportError() {
        errors += 1
      },
    })

    await store.initialize()
    shouldFail = true
    assert.deepEqual(await store.refresh(), profile)
    assert.equal(clears, 0)
    assert.equal(errors, 1)
    assert.equal(store.authenticated.value, true)
    assert.deepEqual(store.state.profile, profile)
  })

  test('an explicit null profile clears the current session', async () => {
    let authenticated = true
    let clears = 0
    const store = createAuthStore({
      clearSession() {
        clears += 1
      },
      async loadProfile() {
        return authenticated ? profile : null
      },
    })

    await store.initialize()
    authenticated = false
    assert.equal(await store.refresh(), null)
    assert.equal(clears, 1)
    assert.equal(store.authenticated.value, false)
    assert.equal(store.state.loginState, 'unauthenticated')
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

  test('applies a mutation profile and ignores an older in-flight request', async () => {
    let resolveProfile: ((value: UserProfile) => void) | undefined
    const store = createAuthStore({
      clearSession() {},
      loadProfile() {
        return new Promise<UserProfile>((resolve) => {
          resolveProfile = resolve
        })
      },
    })
    const stale = store.initialize()
    const updated = { ...profile, avatar: 'new-avatar' }

    assert.deepEqual(store.apply(updated), updated)
    resolveProfile?.(profile)
    await stale

    assert.deepEqual(store.state.profile, updated)
    assert.deepEqual(await store.ready(), updated)
  })

  test('a pre-login profile response cannot overwrite an established session', async () => {
    let resolveProfile: ((value: UserProfile | null) => void) | undefined
    let hydratedCsrf = ''
    const store = createAuthStore({
      clearSession() {},
      applyHydratedSession(_profile, csrfToken) {
        hydratedCsrf = csrfToken ?? ''
      },
      loadProfile() {
        return new Promise<UserProfile | null>((resolve) => {
          resolveProfile = resolve
        })
      },
    })
    const stale = store.initialize()
    const loggedIn = { ...profile, id: 'new-session' }

    store.establish({ profile: loggedIn, csrfToken: 'csrf-new' })
    resolveProfile?.(null)
    await stale

    assert.equal(store.state.userId, 'new-session')
    assert.equal(store.state.loginState, 'authenticated')
    assert.equal(hydratedCsrf, 'csrf-new')
  })

  test('only a 401 from the current session epoch clears authentication', () => {
    const store = createAuthStore({
      clearSession() {},
      async loadProfile() {
        return null
      },
    })
    const oldEpoch = store.currentSessionEpoch()
    store.establish({ profile, csrfToken: 'csrf' })

    assert.equal(store.clearIfSessionEpoch(oldEpoch), false)
    assert.equal(store.state.loginState, 'authenticated')
    assert.equal(store.clearIfSessionEpoch(store.currentSessionEpoch()), true)
    assert.equal(store.state.loginState, 'unauthenticated')
  })

  test('an unconfirmed startup remains loading and retries after a network failure', async () => {
    let loads = 0
    const store = createAuthStore({
      clearSession() {},
      async loadProfile() {
        loads += 1
        if (loads === 1) throw new Error('offline')
        return profile
      },
    })

    assert.equal(await store.initialize(), null)
    assert.equal(store.state.loginState, 'loading')
    assert.equal(store.state.userId, null)
    assert.equal(await store.ensureAuthenticated(), true)
    assert.equal(loads, 2)
    assert.equal(store.state.loginState, 'authenticated')
    assert.equal(store.state.userId, profile.id)
  })
})

test('automatic theme selection resolves by audience outside the birthday', () => {
  const date = new Date('2026-08-13T00:00:00Z')
  assert.equal(
    resolveThemeSelection('auto', 'desktop', date).id,
    'auto-landscape',
  )
  assert.equal(
    resolveThemeSelection(undefined, 'mobile', date).id,
    'auto-portrait',
  )
  assert.equal(
    resolveThemeSelection('mainline', 'mobile', date).id,
    'auto-portrait',
  )
})
