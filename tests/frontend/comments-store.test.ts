import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { nextTick } from 'vue'
import type { CommentsApi } from '../../src/features/comments/comments-api'
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

  test('ignores a stale response after a numbered jump', async () => {
    const initial = deferred<CommentPage>()
    const jumped = deferred<CommentPage>()
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        list() {
          calls += 1
          return calls === 1 ? initial.promise : jumped.promise
        },
      }),
    )

    const loading = store.initialize()
    const jumping = store.gotoNumber(42)
    jumped.resolve({ items: [comment(42)], hasMore: false })
    await jumping
    initial.resolve({ items: [comment(1)], hasMore: false })
    await loading
    assert.equal(store.state.jumpNumber, 42)
    assert.deepEqual(
      store.state.items.map((item) => item.id),
      [42],
    )
  })

  test('updates a successful like from the server snapshot', async () => {
    let liked = false
    let calls = 0
    const store = createCommentsStore(
      apiWith({
        async list(query) {
          if (query?.from) {
            return {
              items: [comment(1, { liked: true, likes: 3 })],
              hasMore: false,
            }
          }
          return { items: [comment(1)], hasMore: false }
        },
        async like() {
          calls += 1
          liked = true
        },
      }),
    )
    await store.initialize()
    await store.toggleLike(1)
    await nextTick()
    assert.equal(liked, true)
    await store.toggleLike(1)
    assert.equal(calls, 1)
    assert.equal(store.state.items[0]?.liked, true)
    assert.equal(store.state.items[0]?.likes, 3)
  })

  test('rolls an optimistic like back when the request fails', async () => {
    const store = createCommentsStore(
      apiWith({
        async list() {
          return { items: [comment(1, { likes: 2 })], hasMore: false }
        },
        async like() {
          throw new Error('offline')
        },
      }),
    )
    await store.initialize()
    await assert.rejects(store.toggleLike(1), /offline/)
    assert.equal(store.state.items[0]?.liked, false)
    assert.equal(store.state.items[0]?.likes, 2)
  })
})
