import assert from 'node:assert/strict'
import { test } from 'node:test'
import type {
  CommentsApi,
  CommentQuery,
} from '../../src/features/comments/comments-api'
import { createCommentsStore } from '../../src/features/comments/comments-store'
import type {
  CommentPage,
  CommentRecord,
} from '../../src/features/comments/comment-types'
import { createViewLifecycle } from '../../src/features/comments/user-home-lifecycle'

function comment(
  id: number,
  overrides: Partial<CommentRecord> = {},
): CommentRecord {
  return {
    id,
    displayId: id,
    uid: 'u-1',
    sender: '用户',
    avatar: '',
    comment: `留言 ${id}`,
    image: '',
    time: id,
    hidden: false,
    liked: false,
    likes: 0,
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
  return { promise, resolve: resolveValue, reject: rejectValue }
}

function apiWith(overrides: Partial<CommentsApi>): CommentsApi {
  return {
    create: async () => comment(99),
    deleteUpload: async () => {},
    getCount: async () => 0,
    getViewerLikes: async () => [],
    like: async () => ({ liked: true, likes: 1 }),
    list: async () => ({ items: [], hasMore: false }),
    listUser: async () => ({ items: [], hasMore: false, nextCursor: null }),
    report: async () => {},
    upload: async () => 'image',
    ...overrides,
  }
}

test('concurrent initialize calls share one request and clear loading', async () => {
  const request = deferred<CommentPage>()
  let calls = 0
  const store = createCommentsStore(
    apiWith({
      list: async () => {
        calls += 1
        return request.promise
      },
    }),
  )
  const first = store.initialize()
  const second = store.initialize()
  assert.equal(calls, 1)
  request.resolve({ items: [comment(1)], hasMore: false })
  await Promise.all([first, second])
  assert.equal(store.state.loadingInitial, false)
  assert.deepEqual(
    store.state.items.map((item) => item.id),
    [1],
  )
})

test('cache revalidation merges updates, additions, and keeps cached likes public', async () => {
  const cache = comment(1, { liked: true, likes: 4 })
  const request = deferred<CommentPage>()
  const storage = new Map<string, string>()
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      sessionStorage: {
        getItem: (key: string) => storage.get(key) ?? null,
        setItem: (key: string, value: string) => storage.set(key, value),
        removeItem: (key: string) => storage.delete(key),
      },
    },
  })
  storage.set(
    'elytrue:home-comments:v1',
    JSON.stringify({
      version: 1,
      savedAt: Date.now(),
      items: [cache],
      hasMore: false,
    }),
  )
  const store = createCommentsStore(
    apiWith({ list: async () => request.promise }),
  )
  const loading = store.initialize()
  assert.equal(store.state.items[0]?.liked, false)
  request.resolve({
    items: [comment(1, { comment: '更新' }), comment(2)],
    hasMore: false,
  })
  await loading
  assert.deepEqual(
    store.state.items.map((item) => item.id),
    [2, 1],
  )
  assert.equal(store.state.items.find((item) => item.id === 1)?.comment, '更新')
  assert.equal(store.state.items.find((item) => item.id === 1)?.liked, false)
  delete (globalThis as { window?: unknown }).window
})

test('a posted comment survives a refresh response and increments today count once', async () => {
  const refresh = deferred<CommentPage>()
  const store = createCommentsStore(
    apiWith({
      list: async (query?: CommentQuery) =>
        query?.count === 10 ? refresh.promise : { items: [], hasMore: false },
    }),
  )
  const refreshing = store.refresh()
  store.insertCreatedComment(comment(10))
  refresh.resolve({ items: [comment(9)], hasMore: false })
  await refreshing
  assert.deepEqual(
    store.state.items.map((item) => item.id),
    [10, 9],
  )
  assert.equal(store.state.todayCount, 1)
  assert.deepEqual([...store.consumeAnimationIds()], [10, 9])
})

test('a newer replacement wins over an older successful jump response', async () => {
  const first = deferred<CommentPage>()
  const second = deferred<CommentPage>()
  let calls = 0
  const store = createCommentsStore(
    apiWith({
      list: async () => (++calls === 1 ? first.promise : second.promise),
    }),
  )
  const oldJump = store.gotoNumber(1)
  const newJump = store.gotoNumber(2)
  second.resolve({ items: [comment(2)], hasMore: false })
  await newJump
  first.resolve({ items: [comment(1)], hasMore: false })
  await oldJump
  assert.deepEqual(
    store.state.items.map((item) => item.id),
    [2],
  )
  assert.equal(store.state.jumping, true)
  store.finishJump()
  assert.equal(store.state.loadingInitial, false)
})

test('older and newer pagination requests are independently deduplicated', async () => {
  const older = deferred<CommentPage>()
  const newer = deferred<CommentPage>()
  let calls = 0
  const queries: CommentQuery[] = []
  const store = createCommentsStore(
    apiWith({
      list: async (query = {}) => {
        queries.push(query)
        calls += 1
        if (calls === 1) return { items: [comment(2)], hasMore: true }
        if (query.direction === 'before') return older.promise
        return newer.promise
      },
    }),
  )
  await store.gotoNumber(2)
  store.finishJump()
  const oldA = store.loadOlder()
  const oldB = store.loadOlder()
  const newA = store.loadNewer()
  const newB = store.loadNewer()
  assert.equal(oldA, oldB)
  assert.equal(newA, newB)
  older.resolve({ items: [comment(1)], hasMore: false })
  newer.resolve({ items: [comment(3)], hasMore: false })
  await Promise.all([oldA, newA])
  assert.equal(calls, 3)
  assert.equal(store.state.loadingOlder, false)
  assert.equal(store.state.loadingNewer, false)
  assert.deepEqual(
    queries
      .slice(1)
      .map((query) => query.direction)
      .sort(),
    ['after', 'before'],
  )
})

test('hydration started during a like cannot overwrite the local mutation', async () => {
  const hydration = deferred<Array<{ id: number; liked: boolean }>>()
  const store = createCommentsStore(
    apiWith({
      list: async () => ({ items: [comment(1)], hasMore: false }),
      getViewerLikes: async () => hydration.promise,
    }),
  )
  await store.initialize()
  const liking = store.toggleLike(1)
  const filling = store.hydrateViewerLikes()
  hydration.resolve([{ id: 1, liked: false }])
  await filling
  await liking
  assert.equal(store.state.items[0]?.liked, true)
})

test('a stale count response cannot cross a Shanghai date boundary', async () => {
  const originalNow = Date.now
  const first = deferred<number>()
  const second = deferred<number>()
  let now = Date.parse('2026-08-05T15:59:59.000Z')
  let calls = 0
  Date.now = () => now
  try {
    const store = createCommentsStore(
      apiWith({
        getCount: async () => (++calls === 1 ? first.promise : second.promise),
      }),
    )
    const old = store.refreshTodayCount()
    now = Date.parse('2026-08-05T16:00:01.000Z')
    const fresh = store.refreshTodayCount()
    second.resolve(8)
    await fresh
    first.resolve(2)
    await old
    assert.equal(store.state.todayCount, 8)
  } finally {
    Date.now = originalNow
  }
})

test('disposing a user view ignores a late async response', () => {
  const lifecycle = createViewLifecycle()
  let applied = false
  lifecycle.dispose()
  if (lifecycle.isActive()) applied = true
  assert.equal(applied, false)
})
