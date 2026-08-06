import type { ApiEnvelope } from '../../lib/api-client'
import XHR from '../../net/xhr'
import { markPerformanceEvent } from '../../lib/performance'
import { invalidateUserHomeCache } from './user-home-cache'
import {
  parseCommentPage,
  parseUserCommentPage,
  type CommentPage,
  type CommentRecord,
  type UserCommentPage,
} from './comment-types'

export interface CommentQuery {
  count?: number
  cursor?: number
  direction?: 'after' | 'before'
  from?: number
  number?: number | string
  time?: number
  uid?: string
}

export interface CreateCommentPayload {
  comment: string
  imageKeys: string[]
  replyid?: number
}

export interface LikeResult {
  liked: boolean
  likes: number
}

export interface ViewerLikeState {
  id: number
  liked: boolean
}

export interface CommentsApi {
  create(payload: CreateCommentPayload): Promise<CommentRecord>
  deleteUpload(imageId: string): Promise<void>
  getCount(): Promise<number>
  getViewerLikes(ids: number[]): Promise<ViewerLikeState[]>
  like(commentId: number, liked: boolean): Promise<LikeResult | void>
  listInitial?(): Promise<CommentPage>
  list(query?: CommentQuery): Promise<CommentPage>
  listUser(
    uid: string,
    cursor?: number | string,
    signal?: AbortSignal,
  ): Promise<UserCommentPage>
  report(commentId: number, reason: string): Promise<void>
  upload(image: string): Promise<string>
}

const userPageCache = new Map<
  string,
  { page: UserCommentPage; expiresAt: number }
>()
const USER_PAGE_CACHE_TTL = 30_000
const USER_PAGE_CACHE_LIMIT = 8

export function getCachedUserCommentPage(
  cacheKey: string,
): UserCommentPage | null {
  const cached = userPageCache.get(cacheKey)
  if (!cached || cached.expiresAt <= Date.now()) {
    userPageCache.delete(cacheKey)
    return null
  }
  userPageCache.delete(cacheKey)
  userPageCache.set(cacheKey, cached)
  return cached.page
}

export function cacheUserCommentPage(
  cacheKey: string,
  page: UserCommentPage,
): void {
  userPageCache.delete(cacheKey)
  userPageCache.set(cacheKey, {
    page,
    expiresAt: Date.now() + USER_PAGE_CACHE_TTL,
  })
  while (userPageCache.size > USER_PAGE_CACHE_LIMIT) {
    const oldest = userPageCache.keys().next().value
    if (typeof oldest !== 'string') break
    userPageCache.delete(oldest)
  }
}

export function invalidateUserCommentCache(cacheKey?: string): void {
  if (cacheKey) userPageCache.delete(cacheKey)
  else {
    userPageCache.clear()
    invalidateUserHomeCache()
  }
}

function requireSuccess(response: ApiEnvelope<unknown>): void {
  if (response.code !== 1) throw new Error(response.message)
}

function parseImageId(response: ApiEnvelope<unknown>): string {
  requireSuccess(response)
  if (typeof response.data !== 'object' || response.data === null) {
    throw new Error('上传响应无效')
  }
  const imageId = Reflect.get(response.data, 'imageId')
  if (typeof imageId !== 'string' || !imageId)
    throw new Error('上传响应缺少图片 ID')
  return imageId
}

export const commentsApi: CommentsApi = {
  async listInitial() {
    markPerformanceEvent('comments-request-start', { public: true })
    const page = parseCommentPage(
      await XHR.get<unknown>('comments/public', { count: 10 }),
    )
    markPerformanceEvent('comments-response', {
      public: true,
      count: page.items.length,
    })
    return page
  },
  async list(query = {}) {
    markPerformanceEvent('comments-request-start', { public: false })
    const page = parseCommentPage(await XHR.get<unknown>('comments', query))
    markPerformanceEvent('comments-response', {
      public: false,
      count: page.items.length,
    })
    return page
  },
  async getCount() {
    const count = Number(await XHR.get<unknown>('comments/count'))
    return Number.isFinite(count) ? count : 0
  },
  async getViewerLikes(ids) {
    if (!ids.length) return []
    const result = await XHR.get<unknown>('comments/viewer-likes', {
      ids: ids.join(','),
    })
    if (!Array.isArray(result)) return []
    return result.flatMap((item) => {
      if (
        typeof item !== 'object' ||
        item === null ||
        !Number.isSafeInteger(Number(Reflect.get(item, 'id')))
      )
        return []
      return [
        {
          id: Number(Reflect.get(item, 'id')),
          liked: Reflect.get(item, 'liked') === true,
        },
      ]
    })
  },
  async listUser(uid, cursor, signal) {
    return parseUserCommentPage(
      await XHR.get<unknown>(
        'comments',
        { uid, count: 20, cursor },
        { signal },
      ),
    )
  },
  async like(commentId, liked) {
    const path = `comments/like?commentId=${commentId}`
    const response = liked ? await XHR.delete(path) : await XHR.post(path)
    requireSuccess(response)
    if (
      typeof response.data === 'object' &&
      response.data !== null &&
      typeof Reflect.get(response.data, 'liked') === 'boolean' &&
      typeof Reflect.get(response.data, 'likes') === 'number'
    ) {
      return {
        liked: Reflect.get(response.data, 'liked'),
        likes: Reflect.get(response.data, 'likes'),
      }
    }
    return undefined
  },
  async report(commentId, reason) {
    requireSuccess(await XHR.post('comments/report', { commentId, reason }))
  },
  async upload(image) {
    return parseImageId(await XHR.post<unknown>('uploads/image', { image }))
  },
  async deleteUpload(imageId) {
    requireSuccess(
      await XHR.delete(`uploads/image?imageId=${imageId}`, undefined, {
        silentStatuses: [404, 409],
      }),
    )
  },
  async create(payload) {
    const response = await XHR.post<unknown>('comments/post', payload)
    requireSuccess(response)
    return parseCommentPage([response.data]).items[0]!
  },
}

export function loadInitialComments(api: CommentsApi): Promise<CommentPage> {
  return api.listInitial?.() ?? api.list({ count: 10 })
}

export async function getComment(
  api: CommentsApi,
  id: number,
): Promise<CommentRecord | undefined> {
  return (await api.list({ from: id, count: 1 })).items[0]
}
