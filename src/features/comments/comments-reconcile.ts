import type { CommentRecord, ReplyPreview } from './comment-types'

export interface CommentReconcileResult {
  items: CommentRecord[]
  newIds: Set<number>
  removedIds: Set<number>
  changedIds: Set<number>
}

function sameReply(
  left: ReplyPreview | undefined,
  right: ReplyPreview | undefined,
): boolean {
  if (left === right) return true
  if (!left || !right) return false
  return (
    left.id === right.id &&
    left.number === right.number &&
    left.displayId === right.displayId &&
    left.sender === right.sender &&
    left.avatar === right.avatar &&
    left.comment === right.comment &&
    left.deleted === right.deleted
  )
}

function updateRecord(
  current: CommentRecord,
  incoming: CommentRecord,
): boolean {
  let changed = false
  for (const key of [
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
  ] as const) {
    if (!Object.is(current[key], incoming[key])) {
      current[key] = incoming[key] as never
      changed = true
    }
  }
  if (!sameReply(current.replyPreview, incoming.replyPreview)) {
    if (incoming.replyPreview === undefined) delete current.replyPreview
    else current.replyPreview = incoming.replyPreview
    changed = true
  }
  return changed
}

export function reconcileComments(
  current: CommentRecord[],
  incoming: CommentRecord[],
): CommentReconcileResult {
  const currentById = new Map(current.map((item) => [item.id, item]))
  const incomingIds = new Set(incoming.map((item) => item.id))
  const newIds = new Set<number>()
  const removedIds = new Set<number>()
  const changedIds = new Set<number>()
  const items = incoming.map((item) => {
    const existing = currentById.get(item.id)
    if (!existing) {
      newIds.add(item.id)
      return item
    }
    if (updateRecord(existing, item)) changedIds.add(item.id)
    return existing
  })
  for (const item of current) {
    if (!incomingIds.has(item.id)) removedIds.add(item.id)
  }
  return { items, newIds, removedIds, changedIds }
}
