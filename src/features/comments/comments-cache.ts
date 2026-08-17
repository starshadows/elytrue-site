import { parseCommentRecord, type CommentRecord } from './comment-types'

export const HOME_COMMENTS_CACHE_KEY = 'elytrue:home-comments:v1'
export const COMMENTS_CONSISTENCY_KEY = 'elytrue:comments-consistency:v1'
export const LOCAL_COMMENT_JOURNAL_KEY = 'elytrue:local-comments:v1'
export const HOME_COMMENTS_CACHE_TTL = 60 * 1_000
export const HOME_COMMENTS_CACHE_LIMIT = 30

export type LocalCommentJournalState = 'PENDING_LOCAL' | 'VERIFY_REQUIRED'

/** Kept for one-way migration from the former v1 home cache. */
export interface LocalCommentConfirmation {
  confirmedAt: number
  visibleSinceRevision?: number
}

export interface LocalCommentJournalEntry extends LocalCommentConfirmation {
  id: number
  comment: CommentRecord
  state: LocalCommentJournalState
  verificationAttempts: number
  nextVerifyAt: number
}

export interface CommentsConsistencyMetadata {
  version: 1
  lastAcceptedSnapshotRevision?: number
}

export interface CachedHomeComments {
  version: 1 | 2
  savedAt: number
  items: CommentRecord[]
  hasMore: boolean
  nextCursor?: number
  date?: string
  todayCount?: number
  snapshotRevision?: number
  /** Present only while migrating an old combined cache. */
  localConfirmations?: Array<LocalCommentConfirmation & { id: number }>
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
    ...(record.visibleSinceRevision === undefined
      ? {}
      : { visibleSinceRevision: record.visibleSinceRevision }),
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
  'visibleSinceRevision',
  'hidden',
  'liked',
  'likes',
  'replyPreview',
])

function validRevision(value: unknown): value is number {
  return Number.isSafeInteger(value) && Number(value) > 0
}

function safeWrite(key: string, value: unknown): boolean {
  const store = storage()
  if (!store) return false
  try {
    store.setItem(key, JSON.stringify(value))
    return true
  } catch {
    return false
  }
}

export function readCommentsConsistency(): CommentsConsistencyMetadata {
  const store = storage()
  if (!store) return { version: 1 }
  try {
    const raw = store.getItem(COMMENTS_CONSISTENCY_KEY)
    if (!raw) return { version: 1 }
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null) throw new Error()
    const version = Reflect.get(value, 'version')
    const revision = Reflect.get(value, 'lastAcceptedSnapshotRevision')
    if (version !== 1 || (revision !== undefined && !validRevision(revision))) {
      throw new Error()
    }
    return {
      version: 1,
      ...(revision === undefined
        ? {}
        : { lastAcceptedSnapshotRevision: Number(revision) }),
    }
  } catch {
    return { version: 1 }
  }
}

export function writeCommentsConsistency(
  lastAcceptedSnapshotRevision?: number,
): boolean {
  if (
    lastAcceptedSnapshotRevision !== undefined &&
    !validRevision(lastAcceptedSnapshotRevision)
  ) {
    return false
  }
  return safeWrite(COMMENTS_CONSISTENCY_KEY, {
    version: 1,
    ...(lastAcceptedSnapshotRevision === undefined
      ? {}
      : { lastAcceptedSnapshotRevision }),
  } satisfies CommentsConsistencyMetadata)
}

export function readHomeCommentsCache(
  now = Date.now(),
  consistency = readCommentsConsistency(),
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
    const date = Reflect.get(value, 'date')
    const todayCount = Reflect.get(value, 'todayCount')
    const snapshotRevision = Reflect.get(value, 'snapshotRevision')
    const localConfirmations = Reflect.get(value, 'localConfirmations')
    if (
      (version !== 1 && version !== 2) ||
      typeof savedAt !== 'number' ||
      !Number.isFinite(savedAt) ||
      savedAt > now ||
      now - savedAt > HOME_COMMENTS_CACHE_TTL ||
      !Array.isArray(items) ||
      items.length > HOME_COMMENTS_CACHE_LIMIT ||
      typeof hasMore !== 'boolean' ||
      (nextCursor !== undefined && !Number.isSafeInteger(nextCursor)) ||
      (date !== undefined &&
        (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/u.test(date))) ||
      (todayCount !== undefined &&
        (!Number.isSafeInteger(todayCount) || Number(todayCount) < 0)) ||
      (todayCount !== undefined && date === undefined) ||
      (snapshotRevision !== undefined && !validRevision(snapshotRevision)) ||
      (localConfirmations !== undefined && !Array.isArray(localConfirmations))
    ) {
      throw new Error('缓存字段无效')
    }

    const highWatermark = consistency.lastAcceptedSnapshotRevision
    if (highWatermark !== undefined && snapshotRevision !== highWatermark) {
      throw new Error('缓存版本已回退')
    }
    if (
      items.some(
        (item) =>
          typeof item !== 'object' ||
          item === null ||
          Object.keys(item).some((key) => !CACHE_RECORD_FIELDS.has(key)),
      )
    ) {
      throw new Error('缓存包含未允许字段')
    }
    const parsed = items.map((item) => ({
      ...parseCommentRecord(item),
      liked: false,
    }))
    if (parsed.some((item) => item.hidden)) throw new Error('缓存包含隐藏留言')

    const cachedIds = new Set(parsed.map((item) => item.id))
    const confirmationIds = new Set<number>()
    const parsedConfirmations: Array<
      LocalCommentConfirmation & { id: number }
    > = []
    for (const confirmation of Array.isArray(localConfirmations)
      ? localConfirmations
      : []) {
      if (typeof confirmation !== 'object' || confirmation === null) continue
      const id = Reflect.get(confirmation, 'id')
      const confirmedAt = Reflect.get(confirmation, 'confirmedAt')
      const visibleSinceRevision = Reflect.get(
        confirmation,
        'visibleSinceRevision',
      )
      if (
        !Number.isSafeInteger(id) ||
        typeof confirmedAt !== 'number' ||
        !Number.isFinite(confirmedAt) ||
        (visibleSinceRevision !== undefined &&
          !validRevision(visibleSinceRevision)) ||
        !cachedIds.has(Number(id)) ||
        confirmationIds.has(Number(id))
      ) {
        continue
      }
      confirmationIds.add(Number(id))
      parsedConfirmations.push({
        id: Number(id),
        confirmedAt,
        ...(visibleSinceRevision === undefined
          ? {}
          : { visibleSinceRevision: Number(visibleSinceRevision) }),
      })
    }
    return {
      version: version as 1 | 2,
      savedAt,
      items: parsed,
      hasMore,
      ...(nextCursor === undefined ? {} : { nextCursor: Number(nextCursor) }),
      ...(date === undefined ? {} : { date }),
      ...(todayCount === undefined ? {} : { todayCount: Number(todayCount) }),
      ...(snapshotRevision === undefined
        ? {}
        : { snapshotRevision: Number(snapshotRevision) }),
      ...(parsedConfirmations.length === 0
        ? {}
        : { localConfirmations: parsedConfirmations }),
    }
  } catch {
    try {
      store.removeItem(HOME_COMMENTS_CACHE_KEY)
    } catch {
      // The invalid cache remains unusable when storage itself is blocked.
    }
    return null
  }
}

export function writeHomeCommentsCache(
  items: CommentRecord[],
  hasMore: boolean,
  nextCursor?: number | null,
  metadata: {
    date?: string
    todayCount?: number
    snapshotRevision?: number
  } = {},
): boolean {
  if (
    metadata.snapshotRevision !== undefined &&
    !validRevision(metadata.snapshotRevision)
  ) {
    return false
  }
  const publicItems = items.filter((item) => !item.hidden)
  const cacheItems = publicItems
    .slice(0, HOME_COMMENTS_CACHE_LIMIT)
    .map(publicRecord)
  const truncated = publicItems.length > cacheItems.length
  const cacheHasMore = hasMore || truncated
  const cacheNextCursor = truncated ? cacheItems.at(-1)?.id : nextCursor
  return safeWrite(HOME_COMMENTS_CACHE_KEY, {
    version: 2,
    savedAt: Date.now(),
    items: cacheItems,
    hasMore: cacheHasMore,
    ...(cacheNextCursor === undefined || cacheNextCursor === null
      ? {}
      : { nextCursor: cacheNextCursor }),
    ...(metadata.date === undefined ? {} : { date: metadata.date }),
    ...(metadata.todayCount === undefined
      ? {}
      : { todayCount: metadata.todayCount }),
    ...(metadata.snapshotRevision === undefined
      ? {}
      : { snapshotRevision: metadata.snapshotRevision }),
  })
}

export function readLocalCommentJournal(): LocalCommentJournalEntry[] {
  const store = storage()
  if (!store) return []
  try {
    const raw = store.getItem(LOCAL_COMMENT_JOURNAL_KEY)
    if (!raw) return []
    const value: unknown = JSON.parse(raw)
    if (
      typeof value !== 'object' ||
      value === null ||
      Reflect.get(value, 'version') !== 1 ||
      !Array.isArray(Reflect.get(value, 'entries'))
    ) {
      return []
    }
    const ids = new Set<number>()
    return (Reflect.get(value, 'entries') as unknown[]).flatMap((entry) => {
      try {
        if (typeof entry !== 'object' || entry === null) return []
        const id = Reflect.get(entry, 'id')
        const confirmedAt = Reflect.get(entry, 'confirmedAt')
        const state = Reflect.get(entry, 'state')
        const verificationAttempts = Reflect.get(entry, 'verificationAttempts')
        const nextVerifyAt = Reflect.get(entry, 'nextVerifyAt')
        const visibleSinceRevision = Reflect.get(entry, 'visibleSinceRevision')
        const comment = parseCommentRecord(Reflect.get(entry, 'comment'))
        if (
          !Number.isSafeInteger(id) ||
          Number(id) !== comment.id ||
          ids.has(Number(id)) ||
          typeof confirmedAt !== 'number' ||
          !Number.isFinite(confirmedAt) ||
          (state !== 'PENDING_LOCAL' && state !== 'VERIFY_REQUIRED') ||
          !Number.isSafeInteger(verificationAttempts) ||
          Number(verificationAttempts) < 0 ||
          typeof nextVerifyAt !== 'number' ||
          !Number.isFinite(nextVerifyAt) ||
          (visibleSinceRevision !== undefined &&
            !validRevision(visibleSinceRevision))
        ) {
          return []
        }
        ids.add(Number(id))
        return [
          {
            id: Number(id),
            comment: publicRecord({ ...comment, hidden: false, liked: false }),
            confirmedAt,
            state,
            verificationAttempts: Number(verificationAttempts),
            nextVerifyAt,
            ...(visibleSinceRevision === undefined
              ? {}
              : { visibleSinceRevision: Number(visibleSinceRevision) }),
          },
        ]
      } catch {
        return []
      }
    })
  } catch {
    return []
  }
}

export function writeLocalCommentJournal(
  entries: Iterable<LocalCommentJournalEntry>,
): boolean {
  return safeWrite(LOCAL_COMMENT_JOURNAL_KEY, {
    version: 1,
    entries: [...entries].map((entry) => ({
      ...entry,
      comment: publicRecord(entry.comment),
    })),
  })
}
