export interface CommentRecord {
  id: number
  number?: number
  displayId: number
  uid: string | null
  sender: string
  avatar: string
  comment: string
  image: string
  replyid?: number | null
  time: number
  createdAt?: number
  visibleSinceRevision?: number
  hidden: boolean
  liked: boolean
  likes: number
  replyPreview?: ReplyPreview
}

export interface ReplyPreview {
  id?: number
  number?: number
  displayId: number
  sender: string
  avatar: string
  comment: string
  deleted?: boolean
}

export interface CommentPage {
  items: CommentRecord[]
  hasMore: boolean
  nextCursor?: number | null
  todayCount?: number
  snapshotGeneratedAt?: number
  snapshotRevision?: number
}

export interface UserCommentRecord {
  id: number
  number?: number
  comment: string
  image: string
  time: number
}

export interface UserCommentPage {
  items: UserCommentRecord[]
  hasMore: boolean
  nextCursor: number | string | null
}

function isObject(value: unknown): value is object {
  return typeof value === 'object' && value !== null
}

function numberField(value: object, key: string): number | undefined {
  const field = Reflect.get(value, key)
  return typeof field === 'number' && Number.isFinite(field) ? field : undefined
}

function stringField(value: object, key: string): string | undefined {
  const field = Reflect.get(value, key)
  return typeof field === 'string' ? field : undefined
}

function parseReplyPreview(value: unknown): ReplyPreview | undefined {
  if (value === undefined) return undefined
  if (!isObject(value)) throw new Error('回复摘要无效')
  const displayId = numberField(value, 'displayId')
  const sender = stringField(value, 'sender')
  const avatar = stringField(value, 'avatar')
  const comment = stringField(value, 'comment')
  if (
    displayId === undefined ||
    sender === undefined ||
    avatar === undefined ||
    comment === undefined
  ) {
    throw new Error('回复摘要字段无效')
  }
  return {
    ...(numberField(value, 'id') === undefined
      ? {}
      : { id: numberField(value, 'id') }),
    ...(numberField(value, 'number') === undefined
      ? {}
      : { number: numberField(value, 'number') }),
    displayId,
    sender,
    avatar,
    comment,
    ...(Reflect.get(value, 'deleted') === true ? { deleted: true } : {}),
  }
}

export function parseCommentRecord(value: unknown): CommentRecord {
  if (!isObject(value)) throw new Error('留言响应不是对象')
  const id = numberField(value, 'id')
  const sender = stringField(value, 'sender')
  const avatar = stringField(value, 'avatar')
  const comment = stringField(value, 'comment')
  const image = stringField(value, 'image')
  const time = numberField(value, 'time')
  const likes = numberField(value, 'likes')
  const liked = Reflect.get(value, 'liked')
  const uidValue = Reflect.get(value, 'uid')
  if (
    id === undefined ||
    sender === undefined ||
    avatar === undefined ||
    comment === undefined ||
    image === undefined ||
    time === undefined ||
    likes === undefined ||
    typeof liked !== 'boolean' ||
    !(typeof uidValue === 'string' || uidValue === null)
  ) {
    throw new Error('留言响应字段无效')
  }
  const displayId = numberField(value, 'displayId') ?? id
  const number = numberField(value, 'number')
  const replyid = numberField(value, 'replyid')
  const replyPreview = parseReplyPreview(Reflect.get(value, 'replyPreview'))
  const visibleSinceRevision = numberField(value, 'visibleSinceRevision')
  if (
    visibleSinceRevision !== undefined &&
    (!Number.isSafeInteger(visibleSinceRevision) || visibleSinceRevision <= 0)
  ) {
    throw new Error('留言可见版本无效')
  }
  return {
    id,
    ...(number === undefined ? {} : { number }),
    displayId,
    uid: uidValue,
    sender,
    avatar,
    comment,
    image,
    ...(Reflect.get(value, 'replyid') === null
      ? { replyid: null }
      : replyid === undefined
        ? {}
        : { replyid }),
    time,
    ...(numberField(value, 'createdAt') === undefined
      ? {}
      : { createdAt: numberField(value, 'createdAt') }),
    ...(visibleSinceRevision === undefined ? {} : { visibleSinceRevision }),
    hidden: Reflect.get(value, 'hidden') === true,
    liked,
    likes,
    ...(replyPreview ? { replyPreview } : {}),
  }
}

export function parseCommentPage(value: unknown): CommentPage {
  if (Array.isArray(value)) {
    return { items: value.map(parseCommentRecord), hasMore: false }
  }
  if (!isObject(value)) throw new Error('留言分页响应无效')
  const items = Reflect.get(value, 'items')
  const hasMore = Reflect.get(value, 'hasMore')
  if (!Array.isArray(items) || typeof hasMore !== 'boolean') {
    throw new Error('留言分页字段无效')
  }
  const cursor = Reflect.get(value, 'nextCursor')
  if (!(
    cursor === undefined ||
    cursor === null ||
    typeof cursor === 'number'
  )) {
    throw new Error('留言游标无效')
  }
  const todayCount = Reflect.get(value, 'todayCount')
  if (
    todayCount !== undefined &&
    (typeof todayCount !== 'number' || !Number.isFinite(todayCount))
  ) {
    throw new Error('今日留言数量无效')
  }
  const snapshotGeneratedAt = Reflect.get(value, 'snapshotGeneratedAt')
  if (
    snapshotGeneratedAt !== undefined &&
    (typeof snapshotGeneratedAt !== 'number' ||
      !Number.isFinite(snapshotGeneratedAt) ||
      snapshotGeneratedAt < 0)
  ) {
    throw new Error('留言快照时间无效')
  }
  const snapshotRevision = Reflect.get(value, 'snapshotRevision')
  if (
    snapshotRevision !== undefined &&
    (typeof snapshotRevision !== 'number' ||
      !Number.isSafeInteger(snapshotRevision) ||
      snapshotRevision <= 0)
  ) {
    throw new Error('留言快照版本无效')
  }
  return {
    items: items.map(parseCommentRecord),
    hasMore,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
    ...(todayCount === undefined ? {} : { todayCount }),
    ...(snapshotGeneratedAt === undefined ? {} : { snapshotGeneratedAt }),
    ...(snapshotRevision === undefined ? {} : { snapshotRevision }),
  }
}

export function parseUserCommentPage(value: unknown): UserCommentPage {
  if (!isObject(value)) throw new Error('用户留言分页响应无效')
  const items = Reflect.get(value, 'items')
  const hasMore = Reflect.get(value, 'hasMore')
  const nextCursor = Reflect.get(value, 'nextCursor')
  if (
    !Array.isArray(items) ||
    typeof hasMore !== 'boolean' ||
    !(
      nextCursor === null ||
      typeof nextCursor === 'number' ||
      typeof nextCursor === 'string'
    )
  ) {
    throw new Error('用户留言分页字段无效')
  }
  return {
    items: items.map((item) => {
      if (!isObject(item)) throw new Error('用户留言响应无效')
      const id = numberField(item, 'id')
      const comment = stringField(item, 'comment')
      const image = stringField(item, 'image')
      const time = numberField(item, 'time')
      const number = numberField(item, 'number')
      if (
        id === undefined ||
        comment === undefined ||
        image === undefined ||
        time === undefined
      ) {
        throw new Error('用户留言字段无效')
      }
      return {
        id,
        comment,
        image,
        time,
        ...(number === undefined ? {} : { number }),
      }
    }),
    hasMore,
    nextCursor,
  }
}
