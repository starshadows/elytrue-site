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
