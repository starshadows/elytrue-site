import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  createAuthStore,
  type UserProfile,
} from '../../src/features/auth/auth-store'
import {
  BootstrapProtocolError,
  inspectBootstrapResponse,
  parseBootstrapResponse,
  type ParsedBootstrapResponse,
} from '../../src/features/bootstrap/bootstrap-api'
import { createBootstrapController } from '../../src/features/bootstrap/bootstrap-controller'
import type { CommentsApi } from '../../src/features/comments/comments-api'
import { createCommentsStore } from '../../src/features/comments/comments-store'
import { HOME_COMMENTS_CACHE_KEY } from '../../src/features/comments/comments-cache'
import type {
  CommentPage,
  CommentRecord,
} from '../../src/features/comments/comment-types'

const profile: UserProfile = { id: 'u1', name: '星旅人', avatar: '' }

function comment(id: number, liked = false): CommentRecord {
  return {
    id,
    displayId: id,
    uid: 'u1',
    sender: '星旅人',
    avatar: '',
    comment: `留言 ${id}`,
    image: '',
    time: id,
    hidden: false,
    liked,
    likes: 0,
  }
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    profile: null,
    comments: { items: [comment(1)], hasMore: false },
    todayCount: 1,
    ...overrides,
  }
}

function deferred<T>() {
  let resolveValue!: (value: T) => void
  let rejectValue!: (reason?: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve
    rejectValue = reject
  })
  return { promise, reject: rejectValue, resolve: resolveValue }
}

function harness(bootstrap: Promise<ParsedBootstrapResponse>) {
  const counts = { bootstrap: 0, comments: 0, count: 0, likes: 0, me: 0 }
  let authResult: { profile: UserProfile | null; csrfToken?: string } | null =
    null
  let commentsResult: {
    page: CommentPage
    viewerLikesComplete: boolean
  } | null = null
  const controller = createBootstrapController({
    loadBootstrap() {
      counts.bootstrap += 1
      return bootstrap
    },
    async loadProfile() {
      counts.me += 1
      return profile
    },
    async loadComments() {
      counts.comments += 1
      return { items: [comment(2)], hasMore: false }
    },
    async loadTodayCount() {
      counts.count += 1
      return 9
    },
    async hydrateAuth(source) {
      authResult = await (typeof source === 'function'
        ? source(() => true)
        : source)
      return authResult.profile
    },
    async hydrateComments(source) {
      const result = await (typeof source === 'function'
        ? source(() => true)
        : source)
      commentsResult = result
      return result.viewerLikesComplete
    },
    async hydrateViewerLikes() {
      counts.likes += 1
    },
  })
  return {
    controller,
    counts,
    get authResult() {
      return authResult
    },
    get commentsResult() {
      return commentsResult
    },
  }
}

describe('bootstrap controller', () => {
  test('cold authenticated bootstrap hydrates all state with one request', async () => {
    const state = harness(
      Promise.resolve(
        inspectBootstrapResponse(
          payload({
            profile,
            csrfToken: 'csrf-1',
            comments: { items: [comment(3, true)], hasMore: false },
            todayCount: 4,
          }),
        ),
      ),
    )
    await state.controller.start()
    assert.deepEqual(state.counts, {
      bootstrap: 1,
      comments: 0,
      count: 0,
      likes: 0,
      me: 0,
    })
    assert.equal(state.authResult?.profile?.id, 'u1')
    assert.equal(state.authResult?.csrfToken, 'csrf-1')
    assert.equal(state.commentsResult?.page.todayCount, 4)
  })

  test('comments partial failure falls back only to comments', async () => {
    const state = harness(
      Promise.resolve(
        inspectBootstrapResponse(
          payload({ comments: null, commentsError: true, todayCount: 6 }),
        ),
      ),
    )
    await state.controller.start()
    assert.equal(state.counts.comments, 1)
    assert.equal(state.counts.me, 0)
    assert.equal(state.counts.count, 0)
    assert.equal(state.commentsResult?.page.todayCount, 6)
  })

  test('profile protocol failure falls back only to user/me', async () => {
    const state = harness(
      Promise.resolve(
        inspectBootstrapResponse(payload({ profile: { id: 1 } })),
      ),
    )
    await state.controller.start()
    assert.equal(state.counts.me, 1)
    assert.equal(state.counts.comments, 0)
    assert.equal(state.authResult?.profile?.id, 'u1')
  })

  test('full failure and repeated start execute each fallback once', async () => {
    const state = harness(Promise.reject(new Error('offline')))
    const first = state.controller.start()
    assert.equal(first, state.controller.start())
    await first
    assert.deepEqual(state.counts, {
      bootstrap: 1,
      comments: 1,
      count: 1,
      likes: 1,
      me: 1,
    })
  })

  test('missing liked state triggers viewer-like hydration only when authenticated', async () => {
    const record = { ...comment(4) } as Record<string, unknown>
    delete record.liked
    const state = harness(
      Promise.resolve(
        inspectBootstrapResponse(
          payload({
            profile,
            csrfToken: 'csrf-2',
            comments: { items: [record], hasMore: false },
          }),
        ),
      ),
    )
    await state.controller.start()
    assert.equal(state.counts.likes, 1)
  })

  test('strict parser reports invalid sections', () => {
    assert.throws(
      () => parseBootstrapResponse(payload({ todayCount: 'bad' })),
      (error: unknown) =>
        error instanceof BootstrapProtocolError &&
        error.sections.has('todayCount'),
    )
  })

  test('auth hydration ignores a stale bootstrap without starting its fallback', async () => {
    const request = deferred<ParsedBootstrapResponse>()
    let fallbacks = 0
    const store = createAuthStore({
      clearSession() {},
      async loadProfile() {
        return { ...profile, id: 'new' }
      },
    })
    const controller = createBootstrapController({
      loadBootstrap: () => request.promise,
      async loadProfile() {
        fallbacks += 1
        return profile
      },
      async loadComments() {
        return { items: [], hasMore: false }
      },
      async loadTodayCount() {
        return 0
      },
      hydrateAuth: (source) => store.hydrate(source),
      async hydrateComments(source) {
        await (typeof source === 'function' ? source(() => true) : source)
        return true
      },
      async hydrateViewerLikes() {},
    })
    const startup = controller.start()
    await store.refresh()
    request.resolve(inspectBootstrapResponse(payload({ profile: { id: 1 } })))
    await startup
    assert.equal(store.state.userId, 'new')
    assert.equal(fallbacks, 0)
  })

  test('cached comments reconcile in place without new entrance animation', async () => {
    const storage = new Map<string, string>()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: {
        sessionStorage: {
          getItem: (key: string) => storage.get(key) ?? null,
          removeItem: (key: string) => storage.delete(key),
          setItem: (key: string, value: string) => storage.set(key, value),
        },
      },
    })
    storage.set(
      HOME_COMMENTS_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        items: [comment(5)],
        hasMore: false,
      }),
    )
    const api = {
      async getCount() {
        return 0
      },
      async getViewerLikes() {
        return []
      },
      async list() {
        return { items: [], hasMore: false }
      },
    } as unknown as CommentsApi
    const store = createCommentsStore(api)
    const request = deferred<{
      page: CommentPage
      todayCountResolved: boolean
      viewerLikesComplete: boolean
    }>()
    const hydration = store.hydrateBootstrap(request.promise)
    const cached = store.state.items[0]
    request.resolve({
      page: { items: [{ ...comment(5), comment: '已校准' }], hasMore: false },
      todayCountResolved: true,
      viewerLikesComplete: true,
    })
    await hydration
    assert.equal(store.state.items[0], cached)
    assert.equal(cached?.comment, '已校准')
    assert.deepEqual(store.consumeAnimationIds(), new Set())
    delete (globalThis as { window?: unknown }).window
  })
})
