import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { CommentsApi } from '../../src/features/comments/comments-api'
import {
  commentVerificationBackoff,
  createCommentsStore,
} from '../../src/features/comments/comments-store'
import type {
  CommentPage,
  CommentRecord,
} from '../../src/features/comments/comment-types'
import {
  COMMENTS_CONSISTENCY_KEY,
  HOME_COMMENTS_CACHE_KEY,
  HOME_COMMENTS_CACHE_TTL,
  LOCAL_COMMENT_JOURNAL_KEY,
  readCommentsConsistency,
  readHomeCommentsCache,
  readLocalCommentJournal,
  writeCommentsConsistency,
  writeHomeCommentsCache,
  writeLocalCommentJournal,
  type LocalCommentJournalEntry,
} from '../../src/features/comments/comments-cache'

function comment(
  id: number,
  overrides: Partial<CommentRecord> = {},
): CommentRecord {
  return {
    id,
    displayId: id,
    uid: null,
    sender: '匿名用户',
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

function page(
  revision: number | undefined,
  items: CommentRecord[],
): CommentPage {
  return {
    items,
    hasMore: false,
    todayCount: items.length,
    ...(revision === undefined ? {} : { snapshotRevision: revision }),
  }
}

function apiWith(overrides: Partial<CommentsApi>): CommentsApi {
  return {
    create: async () => comment(100),
    deleteUpload: async () => {},
    getCount: async () => 0,
    getViewerLikes: async () => [],
    like: async () => {},
    list: async () => page(undefined, []),
    listUser: async () => ({ items: [], hasMore: false, nextCursor: null }),
    report: async () => {},
    upload: async () => 'image',
    ...overrides,
  }
}

class TestStorage implements Storage {
  protected values = new Map<string, string>()
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
    return [...this.values.keys()][index] ?? null
  }
  removeItem(key: string): void {
    this.values.delete(key)
  }
  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

class ConsistencyFailingStorage extends TestStorage {
  failedKeys = new Set<string>()
  override setItem(key: string, value: string): void {
    if (this.failedKeys.has(key)) {
      throw new Error('quota')
    }
    super.setItem(key, value)
  }
}

function useStorage(storage: Storage): () => void {
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: { sessionStorage: storage },
  })
  return () => delete (globalThis as { window?: unknown }).window
}

function journalEntry(
  id: number,
  confirmedAt = Date.now(),
): LocalCommentJournalEntry {
  return {
    id,
    comment: comment(id),
    confirmedAt,
    state: 'PENDING_LOCAL',
    verificationAttempts: 0,
    nextVerifyAt: confirmedAt + HOME_COMMENTS_CACHE_TTL,
  }
}

test('snapshot freshness, session consistency, and journal have independent lifetimes', () => {
  const storage = new TestStorage()
  const cleanup = useStorage(storage)
  const now = Date.now()
  try {
    assert.equal(writeCommentsConsistency(9), true)
    assert.equal(
      writeHomeCommentsCache([comment(1)], false, null, {
        snapshotRevision: 9,
      }),
      true,
    )
    assert.equal(
      writeLocalCommentJournal(
        Array.from({ length: 35 }, (_, index) => journalEntry(index + 1, now)),
      ),
      true,
    )
    const cacheReadAt = Date.now()
    assert.equal(readHomeCommentsCache(cacheReadAt)?.snapshotRevision, 9)
    assert.equal(
      readHomeCommentsCache(cacheReadAt + HOME_COMMENTS_CACHE_TTL + 1),
      null,
    )
    assert.equal(readCommentsConsistency().lastAcceptedSnapshotRevision, 9)
    assert.equal(readLocalCommentJournal().length, 35)

    assert.equal(
      writeHomeCommentsCache([comment(2)], false, null, {
        snapshotRevision: 8,
      }),
      true,
    )
    assert.equal(readHomeCommentsCache(Date.now()), null)

    storage.setItem(
      HOME_COMMENTS_CACHE_KEY,
      JSON.stringify({
        version: 2,
        savedAt: Date.now(),
        items: [comment(3)],
        hasMore: false,
      }),
    )
    assert.equal(readHomeCommentsCache(Date.now()), null)
  } finally {
    cleanup()
  }
})

test('a regressed fast snapshot without baseline uses one independent Node fallback', async () => {
  const storage = new TestStorage()
  const cleanup = useStorage(storage)
  try {
    writeCommentsConsistency(5)
    let fastCalls = 0
    let canonicalCalls = 0
    const store = createCommentsStore(
      apiWith({
        async listInitial() {
          fastCalls += 1
          return page(4, [])
        },
        async requestFastInitial() {
          throw new Error('listInitial must own fast single-flight')
        },
        async requestCanonicalInitial() {
          canonicalCalls += 1
          return page(6, [comment(6)])
        },
      }),
    )
    await Promise.all([store.initialize(), store.initialize()])
    assert.equal(fastCalls, 1)
    assert.equal(canonicalCalls, 1)
    assert.equal(store.state.snapshotAcceptance, 'ACCEPTED')
    assert.equal(store.state.items[0]?.id, 6)
  } finally {
    cleanup()
  }
})

test('a regressed fast snapshot preserves baseline and retries Node in background once', async () => {
  const storage = new TestStorage()
  const cleanup = useStorage(storage)
  try {
    writeCommentsConsistency(10)
    writeHomeCommentsCache([comment(1)], false, null, {
      snapshotRevision: 10,
    })
    let canonicalCalls = 0
    let resolveCanonical!: (value: CommentPage) => void
    const canonical = new Promise<CommentPage>((resolve) => {
      resolveCanonical = resolve
    })
    const store = createCommentsStore(
      apiWith({
        listInitial: async () => page(9, []),
        requestFastInitial: async () => page(9, []),
        requestCanonicalInitial: async () => {
          canonicalCalls += 1
          return canonical
        },
      }),
    )
    await store.initialize()
    assert.equal(canonicalCalls, 1)
    assert.equal(store.state.items[0]?.id, 1)
    resolveCanonical(page(11, [comment(2)]))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(store.state.items[0]?.id, 2)
  } finally {
    cleanup()
  }
})

test('durability failure is EPHEMERAL, does not retry Node, and cannot delete baseline', async () => {
  const storage = new ConsistencyFailingStorage()
  const cleanup = useStorage(storage)
  try {
    storage.setItem(
      HOME_COMMENTS_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        items: [comment(1)],
        hasMore: false,
      }),
    )
    const previousCache = storage.getItem(HOME_COMMENTS_CACHE_KEY)
    storage.failedKeys.add(COMMENTS_CONSISTENCY_KEY)
    let canonicalCalls = 0
    const store = createCommentsStore(
      apiWith({
        listInitial: async () => page(5, [comment(2)]),
        requestFastInitial: async () => page(5, [comment(2)]),
        requestCanonicalInitial: async () => {
          canonicalCalls += 1
          return page(5, [comment(2)])
        },
      }),
    )
    await store.initialize()
    assert.equal(canonicalCalls, 0)
    assert.equal(store.state.snapshotAcceptance, 'ACCEPTED')
    assert.equal(store.state.commitDurability, 'EPHEMERAL')
    assert.equal(store.state.persistenceDegraded, true)
    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [2, 1],
    )
    assert.equal(storage.getItem(HOME_COMMENTS_CACHE_KEY), previousCache)
  } finally {
    cleanup()
  }
})

for (const failedKey of [LOCAL_COMMENT_JOURNAL_KEY, HOME_COMMENTS_CACHE_KEY]) {
  test(`a ${failedKey} commit interruption preserves the in-memory baseline`, async () => {
    const storage = new ConsistencyFailingStorage()
    const cleanup = useStorage(storage)
    const local = comment(2)
    try {
      writeCommentsConsistency(5)
      writeHomeCommentsCache([comment(1)], false, null, {
        snapshotRevision: 5,
      })
      writeLocalCommentJournal([journalEntry(local.id)])
      const previousCache = storage.getItem(HOME_COMMENTS_CACHE_KEY)
      storage.failedKeys.add(failedKey)
      const store = createCommentsStore(
        apiWith({ list: async () => page(6, [local, comment(3)]) }),
      )

      await store.initialize()

      assert.equal(store.state.snapshotAcceptance, 'ACCEPTED')
      assert.equal(store.state.commitDurability, 'EPHEMERAL')
      assert.equal(store.state.persistenceDegraded, true)
      assert.deepEqual(
        store.state.items.map((item) => item.id),
        [3, 2, 1],
      )
      assert.equal(readCommentsConsistency().lastAcceptedSnapshotRevision, 6)

      storage.failedKeys.delete(failedKey)
      await store.refreshTodayCount()
      assert.equal(storage.getItem(HOME_COMMENTS_CACHE_KEY), previousCache)
    } finally {
      cleanup()
    }
  })
}

test('revision progress never ACKs membership; inclusion does, then deletion resumes', async () => {
  const storage = new TestStorage()
  const cleanup = useStorage(storage)
  const local = comment(20, { visibleSinceRevision: 5 })
  try {
    storage.setItem(
      HOME_COMMENTS_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        items: [local, comment(19)],
        hasMore: false,
        localConfirmations: [
          { id: local.id, confirmedAt: Date.now(), visibleSinceRevision: 5 },
        ],
      }),
    )
    const responses = [
      page(5, [comment(19)]),
      page(6, [local, comment(19)]),
      page(7, [comment(19)]),
    ]
    const store = createCommentsStore(
      apiWith({
        list: async () => responses.shift() ?? page(7, [comment(19)]),
      }),
    )
    await store.initialize()
    assert.equal(
      store.state.items.some((item) => item.id === local.id),
      true,
    )
    assert.equal(readLocalCommentJournal().length, 1)

    await store.initialize()
    assert.equal(readLocalCommentJournal().length, 0)
    assert.equal(
      store.state.items.some((item) => item.id === local.id),
      true,
    )

    await store.initialize()
    assert.equal(
      store.state.items.some((item) => item.id === local.id),
      false,
    )
  } finally {
    cleanup()
  }
})

test('membership ACK persists the in-memory high-watermark before clearing journal', async () => {
  const storage = new ConsistencyFailingStorage()
  const cleanup = useStorage(storage)
  const local = comment(30)
  try {
    storage.setItem(
      HOME_COMMENTS_CACHE_KEY,
      JSON.stringify({
        version: 1,
        savedAt: Date.now(),
        items: [local, comment(29)],
        hasMore: false,
        localConfirmations: [{ id: local.id, confirmedAt: Date.now() }],
      }),
    )
    storage.failedKeys.add(COMMENTS_CONSISTENCY_KEY)
    const responses = [
      page(5, [comment(29)]),
      page(4, [local, comment(29)]),
      page(4, [local, comment(29)]),
    ]
    const store = createCommentsStore(
      apiWith({ list: async () => responses.shift() ?? page(4, [local]) }),
    )

    await store.initialize()
    assert.equal(store.state.commitDurability, 'EPHEMERAL')
    await store.initialize()
    assert.equal(store.state.snapshotAcceptance, 'REGRESSED')
    assert.equal(readLocalCommentJournal().length, 1)

    storage.failedKeys.delete(COMMENTS_CONSISTENCY_KEY)
    await store.initialize()
    assert.equal(readCommentsConsistency().lastAcceptedSnapshotRevision, 5)
    assert.equal(readLocalCommentJournal().length, 0)
  } finally {
    cleanup()
  }
})

test('verification backoff reaches five minutes and remains capped', () => {
  assert.deepEqual(
    Array.from({ length: 8 }, (_, attempt) =>
      commentVerificationBackoff(attempt),
    ),
    [5_000, 15_000, 30_000, 60_000, 120_000, 300_000, 300_000, 300_000],
  )
})

test('VERIFY_REQUIRED attempts and nextVerifyAt survive a page refresh', async () => {
  const storage = new TestStorage()
  const cleanup = useStorage(storage)
  const originalSetTimeout = globalThis.setTimeout
  const originalClearTimeout = globalThis.clearTimeout
  const scheduled: Array<{ callback: () => void; delay: number }> = []
  globalThis.setTimeout = ((callback: () => void, delay = 0) => {
    scheduled.push({ callback, delay: Number(delay) })
    return scheduled.length
  }) as typeof setTimeout
  globalThis.clearTimeout = (() => {}) as typeof clearTimeout
  let verificationCalls = 0
  const now = Date.now()
  try {
    writeLocalCommentJournal([
      {
        ...journalEntry(50, now - HOME_COMMENTS_CACHE_TTL - 1),
        state: 'VERIFY_REQUIRED',
        nextVerifyAt: now - 1,
      },
    ])
    const verifier = apiWith({
      async verifyVisibility(ids) {
        verificationCalls += 1
        return ids.map((id) => ({ id, state: 'indeterminate' as const }))
      },
    })
    const firstStore = createCommentsStore(verifier)
    await firstStore.initialize()
    assert.equal(scheduled[0]?.delay, 0)
    scheduled.shift()?.callback()
    await new Promise<void>((resolve) => originalSetTimeout(resolve, 0))

    const persisted = readLocalCommentJournal()[0]
    assert.equal(verificationCalls, 1)
    assert.equal(persisted?.verificationAttempts, 1)
    assert.ok(
      Number(persisted?.nextVerifyAt) - Date.now() > 4_500 &&
        Number(persisted?.nextVerifyAt) - Date.now() <= 5_000,
    )

    scheduled.length = 0
    const refreshedStore = createCommentsStore(verifier)
    await refreshedStore.initialize()
    assert.equal(verificationCalls, 1)
    assert.ok(scheduled[0]?.delay > 4_000 && scheduled[0].delay <= 5_000)
  } finally {
    globalThis.setTimeout = originalSetTimeout
    globalThis.clearTimeout = originalClearTimeout
    cleanup()
  }
})
