import type { ApiEnvelope } from '../../lib/api-client'
import XHR from '../../net/xhr'
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

export interface CommentsApi {
  create(payload: CreateCommentPayload): Promise<CommentRecord>
  deleteUpload(imageId: string): Promise<void>
  getCount(): Promise<number>
  like(commentId: number, liked: boolean): Promise<LikeResult | void>
  list(query?: CommentQuery): Promise<CommentPage>
  listUser(uid: string, cursor?: number | string): Promise<UserCommentPage>
  report(commentId: number, reason: string): Promise<void>
  upload(image: string): Promise<string>
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
  async list(query = {}) {
    return parseCommentPage(await XHR.get<unknown>('comments', query))
  },
  async getCount() {
    const count = Number(await XHR.get<unknown>('comments/count'))
    return Number.isFinite(count) ? count : 0
  },
  async listUser(uid, cursor) {
    return parseUserCommentPage(
      await XHR.get<unknown>('comments', { uid, count: 20, cursor }),
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

export async function getComment(
  api: CommentsApi,
  id: number,
): Promise<CommentRecord | undefined> {
  return (await api.list({ from: id, count: 1 })).items[0]
}
