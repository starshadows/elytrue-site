import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { nextTick } from 'vue'
import type {
  CommentQuery,
  CommentsApi,
} from '../../src/features/comments/comments-api'
import { createCommentsStore } from '../../src/features/comments/comments-store'
import {
  HOME_COMMENTS_CACHE_KEY,
  HOME_COMMENTS_CACHE_LIMIT,
  HOME_COMMENTS_CACHE_TTL,
  readHomeCommentsCache,
  readLocalCommentJournal,
  writeHomeCommentsCache,
} from '../../src/features/comments/comments-cache'
import { reconcileComments } from '../../src/features/comments/comments-reconcile'
import {
  parseCommentPage,
  type CommentPage,
  type CommentRecord,
} from '../../src/features/comments/comment-types'

function comment(
  id: number,
  overrides: Partial<CommentRecord> = {},
): CommentRecord {
  return {
    id,
    displayId: id,
    uid: 'user-1',
    sender: 'Elysia',
    avatar: '',
    comment: `message-${id}`,
    image: '',
    time: id,
    hidden: false,
    liked: false,
    likes: 0,
    ...overrides,
  }
}

function deferred<T>() {
  let resolveFn: ((value: T) => void) | undefined
  let rejectFn: ((reason?: unknown) => void) | undefined
  const promise = new Promise<T>((resolve, reject) => {
    resolveFn = resolve
    rejectFn = reject
  })
  return {
    promise,
    resolve: (value: T) => resolveFn?.(value),
    reject: (reason?: unknown) => rejectFn?.(reason),
  }
}

function apiWith(overrides: Partial<CommentsApi>): CommentsApi {
  return {
    async create() {
      return comment(1)
    },
    async deleteUpload() {},
    async getCount() {
      return 0
    },
    async getViewerLikes() {
      return []
    },
    async like() {},
    async list() {
      return { items: [], hasMore: false }
    },
    async listUser() {
      return { items: [], hasMore: false, nextCursor: null }
    },
    async report() {},
    async upload() {
      return 'image-1'
    },
    ...overrides,
  }
}

class TestStorage implements Storage {
  private values = new Map<string, string>()
  get length(): number {
    return this.values.size
  }
  clear(): void {
    this.values.clear()
  }
  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }
  key(index: number): string | null {
    if (index < 0 || index >= this.values.size) return null
    return null
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

describe('comments store', () => {
  test('parses optional public snapshot freshness and causal revision', () => {
    const page = parseCommentPage({
      items: [comment(1, { visibleSinceRevision: 8 })],
      hasMore: false,
      snapshotGeneratedAt: 1234,
      snapshotRevision: 9,
    })
    assert.equal(page.snapshotGeneratedAt, 1234)
    assert.equal(page.snapshotRevision, 9)
    assert.equal(page.items[0]?.visibleSinceRevision, 8)
    assert.throws(
      () =>
        parseCommentPage({
          items: [],
          hasMore: false,
          snapshotGeneratedAt: 'old',
        }),
      /快照时间/u,
    )
    assert.throws(
      () =>
        parseCommentPage({
          items: [],
          hasMore: false,
          snapshotRevision: 0,
        }),
      /快照版本/u,
    )
  })

  test('reconciles by id without replacing unchanged records', () => {
    const first = comment(1)
    const second = comment(2)
    const result = reconcileComments(
      [first, second],
      [comment(2), comment(1, { comment: 'changed' }), comment(3)],
    )

    assert.equal(result.items[0], second)
    assert.equal(result.items[1], first)
    assert.equal(first.comment, 'changed')
    assert.deepEqual(result.newIds, new Set([3]))
    assert.deepEqual(result.removedIds, new Set())
    assert.deepEqual(result.changedIds, new Set([1]))
  })

  test('keeps an identical avatar from marking a comment as changed', () => {
    const current = comment(1, { avatar: 'avatar-1' })
    const result = reconcileComments(
      [current],
      [comment(1, { avatar: 'avatar-1' })],
    )

    assert.equal(result.items[0], current)
    assert.deepEqual(result.changedIds, new Set())
  })

  test('can preserve a missing record without replacing its DOM identity', () => {
    const local = comment(2)
    const result = reconcileComments([local], [], {
      preserveMissing: (item) => item.id === local.id,
    })
    assert.equal(result.items[0], local)
    assert.deepEqual(result.removedIds, new Set())
  })

  test('hydrates public cache before revalidation and animates only new ids', async () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    storage.setItem(
      HOME_COMMENTS_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        items: [comment(1)],
        hasMore: false,
      }),
    )
    const request = deferred<CommentPage>()
    const store = createCommentsStore(
      apiWith({
        list() {
          return request.promise
        },
      }),
    )

    const initializing = store.initialize()
    const cached = store.state.items[0]
    assert.equal(cached?.id, 1)
    assert.equal(store.state.loadingInitial, true)

    request.resolve({
      items: [comment(1, { comment: 'updated' }), comment(2)],
      hasMore: false,
    })
    await initializing

    assert.equal(store.state.items[0]?.id, 2)
    assert.equal(
      store.state.items.find((item) => item.id === 1),
      cached,
    )
    assert.equal(cached?.comment, 'updated')
    assert.deepEqual(store.consumeAnimationIds(), new Set([2]))
    assert.equal(
      store.state.items.some((item) => item.id === 1),
      true,
    )
    delete (globalThis as { window?: unknown }).window
  })

  test('deduplicates an in-flight initial load', async () => {
    const request = deferred<CommentPage>()
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        list() {
          calls += 1
          return request.promise
        },
      }),
    )

    const first = store.initialize()
    const second = store.initialize()
    assert.equal(calls, 1)
    request.resolve({ items: [comment(2), comment(1)], hasMore: false })
    await Promise.all([first, second])
    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [2, 1],
    )
  })

  test('commits initial cards without waiting for the today count', async () => {
    const count = deferred<number>()
    const store = createCommentsStore(
      apiWith({
        async list() {
          return { items: [comment(1)], hasMore: false }
        },
        getCount() {
          return count.promise
        },
      }),
    )

    await Promise.race([
      store.initialize(),
      new Promise((_resolve, reject) =>
        setTimeout(
          () => reject(new Error('initial comments waited for count')),
          50,
        ),
      ),
    ])
    assert.equal(store.state.items[0]?.id, 1)
    assert.equal(store.state.loadingInitial, false)
    count.resolve(4)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(store.state.todayCount, 4)
  })

  test('hydrates viewer likes without replacing visible comment records', async () => {
    const viewer = deferred<Array<{ id: number; liked: boolean }>>()
    const store = createCommentsStore(
      apiWith({
        async list() {
          return { items: [comment(2), comment(1)], hasMore: false }
        },
        getViewerLikes() {
          return viewer.promise
        },
      }),
    )
    await store.initialize()
    const first = store.state.items[0]

    const hydration = store.hydrateViewerLikes()
    assert.equal(store.state.items[0], first)
    viewer.resolve([{ id: 2, liked: true }])
    await hydration

    assert.equal(store.state.items[0], first)
    assert.equal(store.state.items[0]?.liked, true)
    assert.equal(store.state.items[1]?.liked, false)
  })

  test('hydrates viewer likes in batches of at most twenty ids', async () => {
    const batchSizes: number[] = []
    const store = createCommentsStore(
      apiWith({
        async list() {
          return {
            items: Array.from({ length: 45 }, (_, index) =>
              comment(45 - index),
            ),
            hasMore: false,
          }
        },
        async getViewerLikes(ids) {
          batchSizes.push(ids.length)
          return ids.map((id) => ({ id, liked: true }))
        },
      }),
    )
    await store.initialize()

    await store.hydrateViewerLikes()

    assert.deepEqual(batchSizes, [20, 20, 5])
    assert.equal(
      store.state.items.every((item) => item.liked),
      true,
    )
  })

  test('ignores viewer-like hydration after logout or a local like mutation', async () => {
    const firstViewer = deferred<Array<{ id: number; liked: boolean }>>()
    const secondViewer = deferred<Array<{ id: number; liked: boolean }>>()
    let viewerCalls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          return { items: [comment(1)], hasMore: false }
        },
        getViewerLikes() {
          viewerCalls += 1
          return viewerCalls === 1 ? firstViewer.promise : secondViewer.promise
        },
        async like() {
          return { liked: true, likes: 1 }
        },
      }),
    )
    await store.initialize()

    const beforeLogout = store.hydrateViewerLikes()
    store.clearViewerLikes()
    firstViewer.resolve([{ id: 1, liked: true }])
    await beforeLogout
    assert.equal(store.state.items[0]?.liked, false)

    const beforeToggle = store.hydrateViewerLikes()
    await store.toggleLike(1)
    secondViewer.resolve([{ id: 1, liked: false }])
    await beforeToggle
    assert.equal(store.state.items[0]?.liked, true)
  })

  test('ignores an in-flight like result after viewer state is cleared', async () => {
    const likeResult = deferred<{ liked: boolean; likes: number }>()
    const store = createCommentsStore(
      apiWith({
        async list() {
          return { items: [comment(1)], hasMore: false }
        },
        like() {
          return likeResult.promise
        },
      }),
    )
    await store.initialize()

    const pending = store.toggleLike(1)
    store.clearViewerLikes()
    likeResult.resolve({ liked: true, likes: 1 })
    await pending

    assert.equal(store.state.items[0]?.liked, false)
  })

  test('does not let an older count request overwrite a newer count', async () => {
    const firstCount = deferred<number>()
    const secondCount = deferred<number>()
    let countCalls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          return { items: [comment(1)], hasMore: false }
        },
        getCount() {
          countCalls += 1
          return countCalls === 1 ? firstCount.promise : secondCount.promise
        },
      }),
    )
    await store.initialize()
    store.insertCreatedComment(comment(2))
    secondCount.resolve(3)
    await new Promise((resolve) => setTimeout(resolve, 0))
    firstCount.resolve(1)
    await new Promise((resolve) => setTimeout(resolve, 0))

    assert.equal(store.state.todayCount, 3)
  })

  test('inserts a created comment without clearing or refreshing the list', async () => {
    let listCalls = 0
    let countCalls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          listCalls += 1
          return { items: [comment(2), comment(1)], hasMore: true }
        },
        async getCount() {
          countCalls += 1
          return countCalls === 1 ? 2 : 3
        },
      }),
    )
    await store.initialize()
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(store.state.todayCount, 2)

    store.insertCreatedComment(comment(3))
    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [3, 2, 1],
    )
    assert.equal(store.state.todayCount, 3)
    assert.equal(store.state.reachedNewest, true)
    assert.equal(listCalls, 1)
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(countCalls, 2)

    store.insertCreatedComment(comment(3, { comment: 'updated' }))
    assert.equal(store.state.items.filter((item) => item.id === 3).length, 1)
    assert.equal(store.state.items[0]?.comment, 'updated')
    assert.equal(listCalls, 1)
  })

  test('persists the causal revision from a confirmed create response', async () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    const store = createCommentsStore(
      apiWith({
        async list() {
          return { items: [], hasMore: false, todayCount: 0 }
        },
      }),
    )
    try {
      await store.initialize()
      store.insertCreatedComment(
        comment(3, {
          createdAt: Date.now(),
          visibleSinceRevision: 7,
        }),
      )
      const journal = readLocalCommentJournal()
      assert.equal(journal[0]?.comment.visibleSinceRevision, 7)
      assert.deepEqual(
        journal.map((entry) => ({
          id: entry.id,
          visibleSinceRevision: entry.visibleSinceRevision,
        })),
        [{ id: 3, visibleSinceRevision: 7 }],
      )
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test('keeps the current list untouched when refresh finds no new comments', async () => {
    const queries: CommentQuery[] = []
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          return queries.length === 1
            ? { items: [comment(2), comment(1)], hasMore: false }
            : { items: [], hasMore: false }
        },
      }),
    )
    await store.initialize()
    const items = store.state.items
    const newest = items[0]

    await store.refresh()

    assert.equal(store.state.items, items)
    assert.equal(store.state.items[0], newest)
    assert.deepEqual(queries[1], {
      cursor: 2,
      direction: 'after',
      count: -100,
    })
    assert.deepEqual([...store.consumeAnimationIds()], [])
  })

  test('refresh incrementally collects every newer page', async () => {
    const queries: CommentQuery[] = []
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          if (queries.length === 1) {
            return { items: [comment(2), comment(1)], hasMore: true }
          }
          if (query.cursor === 2) {
            return {
              items: [comment(3)],
              hasMore: true,
              nextCursor: 3,
            }
          }
          return { items: [comment(4)], hasMore: false }
        },
      }),
    )
    await store.initialize()

    await store.refresh()

    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [4, 3, 2, 1],
    )
    assert.deepEqual(queries.slice(1), [
      { cursor: 2, direction: 'after', count: -100 },
      { cursor: 3, direction: 'after', count: -100 },
    ])
    assert.deepEqual([...store.consumeAnimationIds()], [3, 4])
  })

  test('stops an incremental refresh when a page repeats without new ids', async () => {
    const queries: CommentQuery[] = []
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          if (queries.length === 1) {
            return { items: [comment(2), comment(1)], hasMore: false }
          }
          return { items: [comment(3)], hasMore: true, nextCursor: 3 }
        },
      }),
    )
    await store.initialize()

    await store.refreshIncrementally()

    assert.equal(queries.length, 3)
    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [3, 2, 1],
    )
    assert.equal(store.state.reachedNewest, true)
  })

  test('caps a single incremental refresh at ten pages', async () => {
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          calls += 1
          if (calls === 1) return { items: [comment(1)], hasMore: false }
          const cursor = Number(query.cursor)
          return {
            items: [comment(cursor + 1)],
            hasMore: true,
            nextCursor: cursor + 1,
          }
        },
      }),
    )
    await store.initialize()

    await store.refreshIncrementally()

    assert.equal(calls, 11)
    assert.equal(store.state.items.length, 11)
    assert.equal(store.state.reachedNewest, true)
  })

  test('caps a single incremental refresh at five hundred additions', async () => {
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          calls += 1
          if (calls === 1) return { items: [comment(1)], hasMore: false }
          const cursor = Number(query.cursor)
          return {
            items: Array.from({ length: 100 }, (_, index) =>
              comment(cursor + index + 1),
            ),
            hasMore: true,
            nextCursor: cursor + 100,
          }
        },
      }),
    )
    await store.initialize()

    await store.refreshIncrementally()

    assert.equal(calls, 6)
    assert.equal(store.state.items.length, 501)
    assert.equal(store.state.reachedNewest, true)
  })

  test('bounds the home cache and stores matching pagination metadata', () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    try {
      writeHomeCommentsCache(
        Array.from({ length: 45 }, (_, index) => comment(45 - index)),
        false,
      )
      const cached = JSON.parse(
        storage.getItem(HOME_COMMENTS_CACHE_KEY) ?? 'null',
      ) as {
        hasMore: boolean
        items: Array<{ id: number }>
        nextCursor?: number
      }
      assert.equal(cached.items.length, HOME_COMMENTS_CACHE_LIMIT)
      assert.equal(cached.hasMore, true)
      assert.equal(cached.nextCursor, 16)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test('keeps compatible metadata for 60 seconds and rejects older snapshots', () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    const now = Date.now()
    try {
      storage.setItem(
        HOME_COMMENTS_CACHE_KEY,
        JSON.stringify({
          version: 1,
          savedAt: now - HOME_COMMENTS_CACHE_TTL + 1,
          items: [comment(1)],
          hasMore: false,
          date: '2026-08-10',
          todayCount: 7,
        }),
      )
      const fresh = readHomeCommentsCache(now)
      assert.equal(fresh?.todayCount, 7)
      assert.equal(fresh?.date, '2026-08-10')

      storage.setItem(
        HOME_COMMENTS_CACHE_KEY,
        JSON.stringify({
          version: 1,
          savedAt: now - 1000,
          items: [comment(1)],
          hasMore: false,
          localConfirmations: [
            { id: 1, confirmedAt: now - HOME_COMMENTS_CACHE_TTL - 1 },
          ],
        }),
      )
      const expiredConfirmation = readHomeCommentsCache(now)
      assert.equal(expiredConfirmation?.items.length, 1)
      assert.equal(expiredConfirmation?.localConfirmations?.length, 1)

      storage.setItem(
        HOME_COMMENTS_CACHE_KEY,
        JSON.stringify({
          version: 1,
          savedAt: now - HOME_COMMENTS_CACHE_TTL - 1,
          items: [comment(1)],
          hasMore: false,
        }),
      )
      assert.equal(readHomeCommentsCache(now), null)
      assert.equal(storage.getItem(HOME_COMMENTS_CACHE_KEY), null)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test('retains a hydrated session snapshot when revalidation fails', async () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    const date = new Date(Date.now() + 8 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10)
    storage.setItem(
      HOME_COMMENTS_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now() - 30_000,
        items: [comment(8)],
        hasMore: false,
        date,
        todayCount: 8,
      }),
    )
    const store = createCommentsStore(
      apiWith({
        async list() {
          throw new Error('offline')
        },
      }),
    )
    try {
      const initializing = store.initialize()
      assert.equal(store.state.items[0]?.id, 8)
      assert.equal(store.state.todayCount, 8)
      await assert.rejects(initializing, /offline/u)
      assert.equal(store.state.items[0]?.id, 8)
      assert.equal(store.state.initialError, true)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test('revision progress alone never removes a locally confirmed cached comment', async () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    const createdAt = Date.now() - 100
    const local = comment(20, {
      createdAt,
      time: createdAt / 1000,
      visibleSinceRevision: 5,
    })
    const stable = comment(19, { createdAt: createdAt - 1000 })
    storage.setItem(
      HOME_COMMENTS_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        items: [local, stable],
        hasMore: false,
        localConfirmations: [
          {
            id: local.id,
            confirmedAt: Date.now(),
            visibleSinceRevision: 5,
          },
        ],
      }),
    )

    const loadWith = async (snapshotRevision?: number) => {
      const store = createCommentsStore(
        apiWith({
          async list() {
            return {
              items: [stable],
              hasMore: false,
              todayCount: 2,
              snapshotGeneratedAt: createdAt + 10_000,
              ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
            }
          },
        }),
      )
      const initializing = store.initialize()
      const cachedLocal = store.state.items.find((item) => item.id === local.id)
      await initializing
      return { store, cachedLocal }
    }

    try {
      const unknown = await loadWith()
      assert.equal(
        unknown.store.state.items.find((item) => item.id === local.id),
        unknown.cachedLocal,
      )

      const stale = await loadWith(4)
      assert.equal(
        stale.store.state.items.some((item) => item.id === local.id),
        true,
      )

      const fresh = await loadWith(5)
      assert.equal(
        fresh.store.state.items.some((item) => item.id === local.id),
        true,
      )
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test('restores cached older pages without requesting the second page twice', async () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    const firstPage = Array.from({ length: 10 }, (_, index) =>
      comment(100 - index),
    )
    const secondPage = Array.from({ length: 10 }, (_, index) =>
      comment(90 - index),
    )
    try {
      let firstCalls = 0
      const firstStore = createCommentsStore(
        apiWith({
          async list() {
            firstCalls += 1
            return firstCalls === 1
              ? { items: firstPage, hasMore: true, nextCursor: 91 }
              : { items: secondPage, hasMore: true, nextCursor: 81 }
          },
        }),
      )
      await firstStore.initialize()
      await firstStore.loadOlder()

      const cached = JSON.parse(
        storage.getItem(HOME_COMMENTS_CACHE_KEY) ?? 'null',
      ) as {
        hasMore: boolean
        items: Array<{ id: number }>
        nextCursor?: number
      }
      assert.equal(cached.items.length, 20)
      assert.equal(cached.nextCursor, 81)

      const restoredQueries: CommentQuery[] = []
      const restoredStore = createCommentsStore(
        apiWith({
          async list(query = {}) {
            restoredQueries.push(query)
            if (restoredQueries.length === 1) {
              return { items: firstPage, hasMore: true, nextCursor: 91 }
            }
            return { items: [comment(80)], hasMore: false }
          },
        }),
      )
      await restoredStore.initialize()
      assert.deepEqual(
        restoredStore.state.items.map((item) => item.id),
        [...firstPage, ...secondPage].map((item) => item.id),
      )

      await restoredStore.loadOlder()
      assert.deepEqual(restoredQueries[1], {
        cursor: 81,
        direction: 'before',
        count: 30,
      })
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test('drops cached older pages when the fresh home page reaches the oldest end', async () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    try {
      writeHomeCommentsCache([comment(3), comment(2), comment(1)], true, 1)
      const store = createCommentsStore(
        apiWith({
          async list() {
            return { items: [comment(3)], hasMore: false }
          },
        }),
      )

      await store.initialize()

      assert.deepEqual(
        store.state.items.map((item) => item.id),
        [3],
      )
      assert.equal(store.state.reachedOldest, true)
      const cached = JSON.parse(
        storage.getItem(HOME_COMMENTS_CACHE_KEY) ?? 'null',
      ) as {
        hasMore: boolean
        items: Array<{ id: number }>
        nextCursor?: number
      }
      assert.deepEqual(
        cached.items.map((item) => item.id),
        [3],
      )
      assert.equal(cached.hasMore, false)
      assert.equal(cached.nextCursor, undefined)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test('does not overwrite the home cache while refreshing a historical view', async () => {
    const storage = new TestStorage()
    Object.defineProperty(globalThis, 'window', {
      configurable: true,
      value: { sessionStorage: storage },
    })
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          calls += 1
          if (calls === 1) return { items: [comment(5)], hasMore: false }
          if (query.number) return { items: [comment(2)], hasMore: false }
          return { items: [], hasMore: false }
        },
      }),
    )
    try {
      await store.initialize()
      const homeCache = storage.getItem(HOME_COMMENTS_CACHE_KEY)
      await store.gotoNumber(2)
      store.finishJump()
      await store.refreshIncrementally()
      assert.equal(storage.getItem(HOME_COMMENTS_CACHE_KEY), homeCache)
    } finally {
      delete (globalThis as { window?: unknown }).window
    }
  })

  test('hydrates only visible likes after authentication in a historical view', async () => {
    const queries: CommentQuery[] = []
    const likedIds: number[][] = []
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          if (query.time) return { items: [comment(20)], hasMore: true }
          return { items: [comment(100)], hasMore: false }
        },
        async getViewerLikes(ids) {
          likedIds.push(ids)
          return ids.map((id) => ({ id, liked: true }))
        },
      }),
    )
    await store.initialize()
    await store.loadAtTime(20)
    const historicalCard = store.state.items[0]

    await store.refreshAfterAuthentication()

    assert.equal(queries.length, 2)
    assert.equal(store.state.items[0], historicalCard)
    assert.equal(historicalCard?.liked, true)
    assert.deepEqual(likedIds, [[20]])
  })

  test('keeps a newly posted comment when an older initial response resolves later', async () => {
    const request = deferred<CommentPage>()
    const store = createCommentsStore(
      apiWith({
        list() {
          return request.promise
        },
      }),
    )

    const initializing = store.initialize()
    store.insertCreatedComment(comment(2))
    request.resolve({ items: [comment(1)], hasMore: false })
    await initializing

    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [2, 1],
    )
  })

  test('uses the server cursor for the next older page', async () => {
    const queries: CommentQuery[] = []
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          if (queries.length === 1) {
            return {
              items: [comment(80), comment(79)],
              hasMore: true,
              nextCursor: 51,
            }
          }
          return { items: [comment(50)], hasMore: false }
        },
      }),
    )

    await store.initialize()
    await store.loadOlder()

    assert.deepEqual(queries[1], {
      cursor: 51,
      direction: 'before',
      count: 30,
    })
  })

  test('uses the server cursor when a newer page scans hidden comments', async () => {
    const queries: CommentQuery[] = []
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          if (query.number) {
            return { items: [comment(20)], hasMore: false }
          }
          if (queries.length === 2) {
            return {
              items: [comment(21)],
              hasMore: true,
              nextCursor: 25,
            }
          }
          return { items: [comment(26)], hasMore: false }
        },
      }),
    )

    await store.gotoNumber(20)
    store.finishJump()
    await store.loadNewer()
    await store.loadNewer()

    assert.deepEqual(queries[2], {
      cursor: 25,
      direction: 'after',
      count: -10,
    })
  })

  test('does not request an older page when the initial page is complete', async () => {
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          calls += 1
          return { items: [], hasMore: false }
        },
      }),
    )

    await store.initialize()
    await store.loadOlder()

    assert.equal(calls, 1)
    assert.equal(store.state.reachedOldest, true)
  })

  test('marks the newest end after the first page without auto loadNewer', async () => {
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          calls += 1
          return {
            items: Array.from({ length: 30 }, (_, index) =>
              comment(30 - index),
            ),
            hasMore: true,
          }
        },
      }),
    )

    await store.initialize()
    assert.equal(store.state.reachedNewest, true)
    assert.equal(store.state.reachedOldest, false)
    await store.loadNewer()
    assert.equal(calls, 1, '首次加载后不得再请求更新留言')
    await store.loadOlder()
    assert.equal(calls, 2, '只有历史方向可以继续分页')
  })

  test('reaches the oldest end when the last page is full but hasMore is false', async () => {
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          calls += 1
          if (calls === 1) {
            return {
              items: Array.from({ length: 30 }, (_, index) =>
                comment(60 - index),
              ),
              hasMore: true,
              nextCursor: 30,
            }
          }
          return {
            items: Array.from({ length: 30 }, (_, index) =>
              comment(30 - index),
            ),
            hasMore: false,
          }
        },
      }),
    )

    await store.initialize()
    assert.equal(store.state.reachedOldest, false)
    await store.loadOlder()
    assert.equal(calls, 2)
    assert.equal(
      store.state.reachedOldest,
      true,
      '最后一页刚好满 30 条且 hasMore=false 也必须到达末端',
    )
    await store.loadOlder()
    assert.equal(calls, 2, '到达末端后不得再请求下一页')
  })

  test('does not start a duplicate pagination request while one is in flight', async () => {
    const request = deferred<CommentPage>()
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          calls += 1
          if (calls === 1) {
            return { items: [comment(10)], hasMore: true, nextCursor: 9 }
          }
          return request.promise
        },
      }),
    )

    await store.initialize()
    const first = store.loadOlder()
    const duplicate = store.loadOlder()
    assert.equal(first, duplicate, '请求未结束时禁止重复触发')
    await nextTick()
    assert.equal(calls, 2)
    request.resolve({ items: [comment(9)], hasMore: false })
    await Promise.all([first, duplicate])
    assert.equal(calls, 2)
  })

  test('clears the loading state after a failed older page and stays retryable', async () => {
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          calls += 1
          if (calls === 1) {
            return { items: [comment(10)], hasMore: true, nextCursor: 9 }
          }
          throw new Error('offline')
        },
      }),
    )

    await store.initialize()
    await assert.rejects(store.loadOlder(), /offline/)
    assert.equal(store.state.loadingOlder, false)
    assert.equal(store.state.reachedOldest, false, '失败后仍可重试')
    assert.equal(store.state.items[0]?.id, 10, '已有留言保持不变')
  })

  test('uses todayCount from the initial page response and skips the count request', async () => {
    let countCalls = 0
    let listCalls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          listCalls += 1
          return { items: [comment(1)], hasMore: false, todayCount: 7 }
        },
        async getCount() {
          countCalls += 1
          return 7
        },
      }),
    )

    await store.initialize()
    assert.equal(store.state.todayCount, 7)
    assert.equal(countCalls, 0, '初始页已含今日数量,不得再发 /comments/count')
    assert.equal(listCalls, 1)
  })

  test('stops initial loading and remains retryable after failure', async () => {
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          calls += 1
          if (calls === 1) throw new Error('offline')
          return { items: [comment(1)], hasMore: false }
        },
      }),
    )

    await assert.rejects(store.initialize(), /offline/)
    assert.equal(store.state.loadingInitial, false)
    assert.equal(store.state.initialError, true)
    await store.initialize()
    assert.equal(calls, 2)
    assert.equal(store.state.initialError, false)
  })

  test('keeps numbered jump state until the rendered target is finished', async () => {
    const request = deferred<CommentPage>()
    const store = createCommentsStore(
      apiWith({
        list() {
          return request.promise
        },
      }),
    )

    const jumping = store.gotoNumber(42)
    assert.equal(store.state.jumpNumber, 42)
    assert.equal(store.state.jumping, true)
    assert.equal(store.state.items.length, 0)

    request.resolve({ items: [comment(42)], hasMore: false })
    await jumping
    assert.equal(store.state.jumpNumber, 42)
    assert.equal(store.state.jumping, true)
    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [42],
    )

    store.finishJump()
    assert.equal(store.state.jumpNumber, null)
    assert.equal(store.state.jumping, false)
  })

  test('restores jump state after a failed request', async () => {
    const request = deferred<CommentPage>()
    const store = createCommentsStore(apiWith({ list: () => request.promise }))

    const jumping = store.gotoNumber(42)
    request.reject(new Error('missing'))
    await assert.rejects(jumping, /missing/)
    assert.equal(store.state.jumpNumber, null)
    assert.equal(store.state.jumping, false)
    assert.equal(store.state.loadingInitial, false)
  })

  test('ignores an older numbered jump response', async () => {
    const first = deferred<CommentPage>()
    const second = deferred<CommentPage>()
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        list() {
          calls += 1
          return calls === 1 ? first.promise : second.promise
        },
      }),
    )

    const firstJump = store.gotoNumber(41)
    const secondJump = store.gotoNumber(42)
    first.reject(new Error('stale jump'))
    await assert.rejects(firstJump, /stale jump/)
    assert.equal(store.state.jumpNumber, 42)
    assert.equal(store.state.jumping, true)
    assert.equal(store.state.items.length, 0)

    second.resolve({ items: [comment(42)], hasMore: false })
    await secondJump
    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [42],
    )
  })

  test('resumes pagination after a jump and clears jump state for timeline loads', async () => {
    const queries: CommentQuery[] = []
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          if (query.number) {
            return { items: [comment(20)], hasMore: false }
          }
          if (query.time) {
            return { items: [comment(10)], hasMore: true }
          }
          if (query.count === -10) {
            return { items: [comment(21)], hasMore: true }
          }
          return { items: [comment(19)], hasMore: true }
        },
      }),
    )

    await store.gotoNumber(20)
    assert.equal(store.state.reachedOldest, false)
    await store.loadNewer()
    await store.loadOlder()
    assert.equal(queries.length, 1)

    store.finishJump()
    await store.loadNewer()
    await store.loadOlder()
    assert.deepEqual(queries.slice(1, 3), [
      { cursor: 20, direction: 'after', count: -10 },
      { cursor: 20, direction: 'before', count: 30 },
    ])

    await store.gotoNumber(20)
    assert.equal(store.state.jumping, true)
    await store.loadAtTime(10)
    assert.equal(store.state.jumpNumber, null)
    assert.equal(store.state.jumping, false)
    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [10],
    )
  })

  test('returns from a historical view to a fresh home page with home cursors', async () => {
    const queries: CommentQuery[] = []
    let initialLoads = 0
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          if (query.time) {
            return {
              items: [comment(20)],
              hasMore: true,
              nextCursor: 19,
            }
          }
          initialLoads += 1
          if (initialLoads === 1) {
            return {
              items: [comment(100), comment(99)],
              hasMore: true,
              nextCursor: 98,
            }
          }
          if (initialLoads === 2) {
            return {
              items: [comment(110), comment(109)],
              hasMore: true,
              nextCursor: 108,
            }
          }
          return { items: [comment(107)], hasMore: false }
        },
      }),
    )
    await store.initialize()
    await store.loadAtTime(20)
    store.setCurrentVisibleTime(20)

    await store.returnToLatest()

    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [110, 109],
    )
    assert.equal(store.state.reachedNewest, true)
    assert.equal(store.state.reachedOldest, false)
    assert.equal(store.state.currentVisibleTime, null)

    await store.loadOlder()
    assert.deepEqual(queries.at(-1), {
      cursor: 108,
      direction: 'before',
      count: 30,
    })
  })

  test('uses legacy from semantics when jumping by an internal id', async () => {
    const queries: CommentQuery[] = []
    const legacyId = 1_755_000_000_000_123
    const store = createCommentsStore(
      apiWith({
        async list(query = {}) {
          queries.push(query)
          return { items: [comment(legacyId)], hasMore: false }
        },
      }),
    )

    await store.gotoId(legacyId)

    assert.deepEqual(queries[0], { from: legacyId, count: 1 })
    assert.equal(store.state.jumpNumber, legacyId)
    assert.equal(store.state.jumping, true)
  })

  test('deduplicates a pending like and allows the next toggle immediately after it settles', async () => {
    const requests = [deferred<void>(), deferred<void>()]
    let serverComment = comment(1)
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list(query) {
          if (query?.from) {
            return { items: [serverComment], hasMore: false }
          }
          return { items: [comment(1)], hasMore: false }
        },
        like() {
          const request = requests[calls]
          calls += 1
          return request?.promise ?? Promise.resolve()
        },
      }),
    )
    await store.initialize()

    const first = store.toggleLike(1)
    const duplicate = store.toggleLike(1)
    assert.equal(first, duplicate)
    assert.equal(store.isLikePending(1), true)
    assert.equal(store.state.items[0]?.liked, true)
    await nextTick()
    assert.equal(calls, 1)
    serverComment = comment(1, { liked: true, likes: 3 })
    requests[0]?.resolve()
    await first
    assert.equal(store.isLikePending(1), false)
    assert.equal(store.state.items[0]?.liked, true)
    assert.equal(store.state.items[0]?.likes, 3)

    const second = store.toggleLike(1)
    assert.equal(store.state.items[0]?.liked, false)
    await nextTick()
    assert.equal(calls, 2)
    serverComment = comment(1, { liked: false, likes: 2 })
    requests[1]?.resolve()
    await second
    assert.equal(store.isLikePending(1), false)
    assert.equal(store.state.items[0]?.liked, false)
    assert.equal(store.state.items[0]?.likes, 2)
  })

  test('rolls an optimistic like back and clears pending after failure', async () => {
    const request = deferred<void>()
    const store = createCommentsStore(
      apiWith({
        async list() {
          return { items: [comment(1, { likes: 2 })], hasMore: false }
        },
        like: () => request.promise,
      }),
    )
    await store.initialize()
    const liking = store.toggleLike(1)
    assert.equal(store.isLikePending(1), true)
    assert.equal(store.state.items[0]?.liked, true)
    assert.equal(store.state.items[0]?.likes, 3)
    request.reject(new Error('offline'))
    await assert.rejects(liking, /offline/)
    assert.equal(store.isLikePending(1), false)
    assert.equal(store.state.items[0]?.liked, false)
    assert.equal(store.state.items[0]?.likes, 2)
  })

  test('uses the like response without fetching the comment again', async () => {
    let listCalls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          listCalls += 1
          return { items: [comment(1)], hasMore: false }
        },
        async like() {
          return { liked: true, likes: 4 }
        },
      }),
    )
    await store.initialize()
    await store.toggleLike(1)
    assert.equal(listCalls, 1)
    assert.equal(store.state.items[0]?.liked, true)
    assert.equal(store.state.items[0]?.likes, 4)
  })

  test('does not let a failed like remove comments added by refresh', async () => {
    const request = deferred<void>()
    let listCalls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          listCalls += 1
          return {
            items: listCalls === 1 ? [comment(1)] : [comment(2, { likes: 5 })],
            hasMore: false,
          }
        },
        like: () => request.promise,
      }),
    )
    await store.initialize()

    const liking = store.toggleLike(1)
    await store.refresh()
    assert.equal(store.state.items[0]?.likes, 5)
    request.reject(new Error('offline'))
    await assert.rejects(liking, /offline/)
    assert.equal(store.state.items.find((item) => item.id === 1)?.liked, false)
    assert.equal(store.state.items.find((item) => item.id === 1)?.likes, 0)
    assert.equal(store.state.items[0]?.id, 2)
    assert.equal(store.state.items[0]?.likes, 5)
    assert.equal(store.isLikePending(1), false)
  })

  test('allows different comments to be liked in parallel', async () => {
    const requests = new Map([
      [1, deferred<void>()],
      [2, deferred<void>()],
    ])
    const calls: number[] = []
    const store = createCommentsStore(
      apiWith({
        async list(query) {
          if (query?.from) {
            return {
              items: [comment(query.from, { liked: true, likes: 1 })],
              hasMore: false,
            }
          }
          return { items: [comment(2), comment(1)], hasMore: false }
        },
        like(id) {
          calls.push(id)
          return requests.get(id)?.promise ?? Promise.resolve()
        },
      }),
    )
    await store.initialize()

    const first = store.toggleLike(1)
    const second = store.toggleLike(2)
    assert.equal(store.isLikePending(1), true)
    assert.equal(store.isLikePending(2), true)
    await nextTick()
    assert.deepEqual(calls, [1, 2])

    requests.get(1)?.resolve()
    requests.get(2)?.resolve()
    await Promise.all([first, second])
    assert.equal(store.isLikePending(1), false)
    assert.equal(store.isLikePending(2), false)
  })
})
