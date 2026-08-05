import { parseCommentRecord, type CommentRecord } from './comment-types'

export const HOME_COMMENTS_CACHE_KEY = 'elytrue:home-comments:v1'
export const HOME_COMMENTS_CACHE_TTL = 5 * 60 * 1_000

export interface CachedHomeComments {
  version: 1
  savedAt: number
  items: CommentRecord[]
  hasMore: boolean
  nextCursor?: number
}

function storage(): Storage | undefined {
  if (typeof window === 'undefined') return undefined
  try {
    return window.sessionStorage
  } catch {
    return undefined
  }
}

function publicRecord(record: CommentRecord): CommentRecord {
  return {
    id: record.id,
    ...(record.number === undefined ? {} : { number: record.number }),
    displayId: record.displayId,
    uid: record.uid,
    sender: record.sender,
    avatar: record.avatar,
    comment: record.comment,
    image: record.image,
    ...(record.replyid === undefined ? {} : { replyid: record.replyid }),
    time: record.time,
    ...(record.createdAt === undefined ? {} : { createdAt: record.createdAt }),
    hidden: false,
    liked: false,
    likes: record.likes,
    ...(record.replyPreview === undefined
      ? {}
      : { replyPreview: record.replyPreview }),
  }
}

const CACHE_RECORD_FIELDS = new Set([
  'id',
  'number',
  'displayId',
  'uid',
  'sender',
  'avatar',
  'comment',
  'image',
  'replyid',
  'time',
  'createdAt',
  'hidden',
  'liked',
  'likes',
  'replyPreview',
])

export function readHomeCommentsCache(
  now = Date.now(),
): CachedHomeComments | null {
  const store = storage()
  if (!store) return null
  try {
    const raw = store.getItem(HOME_COMMENTS_CACHE_KEY)
    if (!raw) return null
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) throw new Error('缓存无效')
    const version = Reflect.get(value, 'version')
    const savedAt = Reflect.get(value, 'savedAt')
    const items = Reflect.get(value, 'items')
    const hasMore = Reflect.get(value, 'hasMore')
    const nextCursor = Reflect.get(value, 'nextCursor')
    if (
      version !== 1 ||
      typeof savedAt !== 'number' ||
      !Number.isFinite(savedAt) ||
      savedAt > now ||
      now - savedAt > HOME_COMMENTS_CACHE_TTL ||
      !Array.isArray(items) ||
      typeof hasMore !== 'boolean' ||
      (nextCursor !== undefined && !Number.isSafeInteger(nextCursor))
    )
      throw new Error('缓存字段无效')
    if (
      items.some(
        (item) =>
          typeof item !== 'object' ||
          item === null ||
          Object.keys(item).some((key) => !CACHE_RECORD_FIELDS.has(key)),
      )
    )
      throw new Error('缓存包含未允许字段')
    const parsed = items.map((item) => ({
      ...parseCommentRecord(item),
      liked: false,
    }))
    if (parsed.some((item) => item.hidden)) throw new Error('缓存包含隐藏留言')
    return {
      version: 1,
      savedAt,
      items: parsed,
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor }),
    }
  } catch {
    try {
      store.removeItem(HOME_COMMENTS_CACHE_KEY)
    } catch {
      // A blocked storage implementation is already unusable.
    }
    return null
  }
}

export function writeHomeCommentsCache(
  items: CommentRecord[],
  hasMore: boolean,
  nextCursor?: number | null,
): void {
  const store = storage()
  if (!store) return
  const value: CachedHomeComments = {
    version: 1,
    savedAt: Date.now(),
    items: items.filter((item) => !item.hidden).map(publicRecord),
    hasMore,
    ...(nextCursor === undefined || nextCursor === null ? {} : { nextCursor }),
  }
  try {
    store.setItem(HOME_COMMENTS_CACHE_KEY, JSON.stringify(value))
  } catch {
    // Storage quota and privacy modes must not block the public request.
  }
}
