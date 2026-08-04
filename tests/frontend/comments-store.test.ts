import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { nextTick } from 'vue'
import type {
  CommentQuery,
  CommentsApi,
} from '../../src/features/comments/comments-api'
import { createCommentsStore } from '../../src/features/comments/comments-store'
import type {
  CommentPage,
  CommentRecord,
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
    async create() {},
    async deleteUpload() {},
    async getCount() {
      return 0
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

describe('comments store', () => {
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
            return { items: [comment(20)], hasMore: true }
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

  test('does not roll a failed like back over a refreshed comment snapshot', async () => {
    const request = deferred<void>()
    let listCalls = 0
    const store = createCommentsStore(
      apiWith({
        async list() {
          listCalls += 1
          return {
            items: [comment(1, { likes: listCalls === 1 ? 0 : 5 })],
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
    assert.equal(store.state.items[0]?.liked, false)
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
