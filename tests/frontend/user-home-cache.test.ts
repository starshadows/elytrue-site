import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import {
  cacheUserHomePage,
  getCachedUserHomePage,
  userHomeCacheKey,
} from '../../src/features/comments/user-home-cache'
import { commentsApi } from '../../src/features/comments/comments-api'
import { prefetchUserHomePage } from '../../src/features/comments/user-home-prefetch'
import type { UserCommentPage } from '../../src/features/comments/comment-types'

class MemoryStorage {
  values = new Map<string, string>()

  getItem(key: string): string | null {
    return this.values.get(key) ?? null
  }

  removeItem(key: string): void {
    this.values.delete(key)
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value)
  }
}

const page: UserCommentPage = {
  items: [
    {
      id: 1,
      number: 8,
      comment: '公开留言',
      image: '',
      time: 1_700_000_001,
    },
  ],
  hasMore: false,
  nextCursor: null,
}

const originalListUser = commentsApi.listUser

afterEach(() => {
  commentsApi.listUser = originalListUser
})

describe('user home cache and prefetch', () => {
  test('uses a versioned viewer/profile key and stores only public fields', () => {
    const storage = new MemoryStorage()
    cacheUserHomePage('viewer-1', 'profile-1', page, storage)

    const key = userHomeCacheKey('viewer-1', 'profile-1')
    const raw = storage.getItem(key)
    assert.ok(raw)
    assert.equal(raw.includes('csrf'), false)
    assert.deepEqual(
      getCachedUserHomePage('viewer-1', 'profile-1', storage),
      page,
    )
    assert.equal(getCachedUserHomePage('viewer-1', 'profile-2', storage), null)
  })

  test('reuses one promise for prefetch and popup loading', async () => {
    let calls = 0
    let resolveRequest: ((value: UserCommentPage) => void) | undefined
    const request = new Promise<UserCommentPage>((resolve) => {
      resolveRequest = resolve
    })
    commentsApi.listUser = async () => {
      calls += 1
      return request
    }

    const first = prefetchUserHomePage({
      viewerId: 'viewer-dedupe',
      profileUserId: 'profile-dedupe',
    })
    const second = prefetchUserHomePage({
      viewerId: 'viewer-dedupe',
      profileUserId: 'profile-dedupe',
    })
    assert.equal(first, second)
    assert.equal(calls, 1)
    resolveRequest?.(page)
    assert.deepEqual(await first, page)
  })
})
