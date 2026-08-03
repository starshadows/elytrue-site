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
  hidden: boolean
  liked: boolean
  likes: number
}

export interface CommentPage {
  items: CommentRecord[]
  hasMore: boolean
  nextCursor?: number | null
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
  nextCursor: number | null
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
    hidden: Reflect.get(value, 'hidden') === true,
    liked,
    likes,
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
  return {
    items: items.map(parseCommentRecord),
    hasMore,
    ...(cursor === undefined ? {} : { nextCursor: cursor }),
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
    !(nextCursor === null || typeof nextCursor === 'number')
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
