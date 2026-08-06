#!/usr/bin/env node
import { getStore } from '@edgeone/pages-blob'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blobKeys } from '../server/domain/blob-keys.js'
import { mapWithConcurrency } from '../server/lib/concurrency.js'
import { getJSON, isPreconditionFailure } from '../server/storage.js'
import {
  COMMENT_READ_CONCURRENCY,
  COMMENT_VIEW_VERSION,
  LATEST_COMMENT_COUNT,
  isCommentCard,
  isLatestCommentView,
  publicViewId,
  toCommentCard,
  userViewId,
  writeCommentViews,
} from '../server/services/comment-view-service.js'
import { countLikeRecords, shanghaiDateString } from '../server/comments.js'
import { preserveCommentNumberBeforeDelete } from '../server/services/report-service.js'

const DATA_STORE = 'elytrue-data'
const PAGE_SIZE = 500

export async function listEvery(store, prefix) {
  const blobs = []
  let cursor
  do {
    const page = await store.list({
      prefix,
      limit: PAGE_SIZE,
      paginate: false,
      ...(cursor ? { cursor } : {}),
      consistency: 'strong',
    })
    const pageBlobs = page?.blobs || []
    blobs.push(...pageBlobs)
    const nextCursor = page?.cursor
    if (!nextCursor || nextCursor === cursor || pageBlobs.length < PAGE_SIZE)
      break
    cursor = nextCursor
  } while (true)
  return blobs
}

function commentIdFromCanonicalKey(key) {
  const match = /^comments\/(\d{16})\.json$/u.exec(String(key))
  return match ? Number(match[1]) : null
}

function cardsEqual(left, right) {
  return JSON.stringify(left) === JSON.stringify(right)
}

async function loadCanonicalComments(data) {
  const blobs = await listEvery(data, 'comments/')
  const comments = await mapWithConcurrency(
    blobs,
    async (blob) => {
      const comment = await getJSON(data, blob.key)
      const keyId = commentIdFromCanonicalKey(blob.key)
      return comment && keyId === Number(comment.id) ? comment : null
    },
    COMMENT_READ_CONCURRENCY,
  )
  return {
    blobCount: blobs.length,
    comments: comments.filter(Boolean),
  }
}

export async function rebuildCommentViews(data, options = {}) {
  const fix = Boolean(options.fix)
  if (fix && !options.confirmProductionRepair) {
    return { aborted: true, reason: 'missing-confirm' }
  }

  const { blobCount, comments } = await loadCanonicalComments(data)
  const canonicalIds = new Set(comments.map((comment) => Number(comment.id)))
  const issues = []
  const repaired = []

  if (comments.length !== blobCount)
    issues.push({ type: 'canonical-corruption' })
  if (fix && comments.length !== blobCount) {
    return { aborted: true, reason: 'canonical-corruption', issues }
  }

  const mutationBlobs = await listEvery(data, 'operations/comment-mutations/')
  for (const blob of mutationBlobs) {
    const match = /^operations\/comment-mutations\/(\d+)\/(\d+)\.json$/u.exec(
      String(blob.key),
    )
    const claim = await getJSON(data, blob.key)
    const commentId = match ? Number(match[1]) : Number(claim?.commentId)
    const version = match ? Number(match[2]) : Number(claim?.version)
    const comment = canonicalIds.has(commentId)
      ? await getJSON(data, blobKeys.comment(commentId))
      : null
    if (
      !claim ||
      !Number.isSafeInteger(commentId) ||
      !Number.isSafeInteger(version)
    ) {
      issues.push({ type: 'invalid-mutation-claim', key: blob.key })
      continue
    }
    if (claim.status !== 'completed') {
      issues.push({ type: 'pending-mutation-claim', commentId, version })
      if (fix && comment && Number(comment.version || 1) >= version) {
        await data.setJSON(blob.key, {
          ...claim,
          status: 'completed',
          completedAt: Date.now(),
        })
        repaired.push(`mutation:${commentId}:${version}`)
      }
    }
  }

  for (const comment of comments) {
    const id = Number(comment.id)
    const number = Number(comment.number)
    if (!Number.isSafeInteger(number) || number <= 0) {
      issues.push({ type: 'invalid-number', commentId: id })
      continue
    }
    const [seat, publicView, userView, likes] = await Promise.all([
      getJSON(data, blobKeys.commentNumber(number)),
      getJSON(data, blobKeys.commentPublicView(id)),
      getJSON(data, blobKeys.commentByUser(comment.uid, id)),
      countLikeRecords(data, id),
    ])
    const expected = toCommentCard({ ...comment, likes })
    const hiddenView = await getJSON(data, blobKeys.commentHiddenView(id))
    if (comment.deleting) {
      issues.push({ type: 'delete-in-progress', commentId: id })
      if (fix) {
        await preserveCommentNumberBeforeDelete(data, comment)
        await data.setJSON(blobKeys.commentNumber(number), {
          ...seat,
          commentId: id,
          number,
          tombstone: true,
          deletedAt: Date.now(),
        })
        await Promise.all([
          data.delete(blobKeys.comment(id)),
          data.delete(blobKeys.commentPublicView(id)),
          data.delete(blobKeys.commentHiddenView(id)),
          data.delete(blobKeys.commentByUser(comment.uid, id)),
          data.delete(blobKeys.commentViewRepair(id)),
        ])
        canonicalIds.delete(id)
        repaired.push(id)
      }
      continue
    }
    if (Number(seat?.commentId) !== id || seat?.tombstone) {
      issues.push({ type: 'number-seat', commentId: id, number })
    }
    if (Number(comment.likes || 0) !== likes) {
      issues.push({ type: 'like-count', commentId: id, actual: likes })
    }
    if (!cardsEqual(userView, expected)) {
      issues.push({ type: 'user-view', commentId: id })
    }
    if (
      comment.hidden ? publicView !== null : !cardsEqual(publicView, expected)
    ) {
      issues.push({ type: 'public-view', commentId: id })
    }
    if (
      comment.hidden ? !cardsEqual(hiddenView, expected) : hiddenView !== null
    ) {
      issues.push({ type: 'hidden-view', commentId: id })
    }

    if (!fix) continue
    const marker = await getJSON(data, blobKeys.commentViewRepair(id))
    const repairedComment = { ...comment, likes }
    Object.assign(comment, repairedComment)
    await data.setJSON(blobKeys.comment(id), repairedComment)
    try {
      await data.setJSON(
        blobKeys.commentNumber(number),
        {
          commentId: id,
          number,
          rebuiltAt: Date.now(),
        },
        { onlyIfNew: true },
      )
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error
      const claimed = await getJSON(data, blobKeys.commentNumber(number))
      if (Number(claimed?.commentId) !== id || claimed?.tombstone) {
        throw new Error(`公开编号 ${number} 已被其他留言占用`)
      }
    }
    await writeCommentViews(data, repairedComment)
    try {
      await data.setJSON(
        blobKeys.commentByDate(shanghaiDateString(comment.createdAt), id),
        { commentId: id, createdAt: comment.createdAt },
        { onlyIfNew: true },
      )
    } catch (error) {
      if (!isPreconditionFailure(error)) throw error
    }
    if (
      marker &&
      Number(marker.commentId) === id &&
      !marker.deleted &&
      (!marker.reason ||
        [
          'create-read-model',
          'latest-view',
          'like',
          'like-canonical',
          'hide',
          'restore',
          'delete',
        ].includes(marker.reason))
    ) {
      await data.delete(blobKeys.commentViewRepair(id)).catch(() => {})
    }
    repaired.push(id)
  }

  const [publicBlobs, hiddenBlobs, userBlobs, repairBlobs] = await Promise.all([
    listEvery(data, blobKeys.commentPublicViewsPrefix),
    listEvery(data, blobKeys.commentHiddenViewsPrefix),
    listEvery(data, 'indexes/comments/by-user/'),
    listEvery(data, 'repairs/comment-views/'),
  ])
  const orphanPublic = publicBlobs.filter(
    (blob) => !canonicalIds.has(publicViewId(blob.key)),
  )
  const orphanHidden = hiddenBlobs.filter(
    (blob) => !canonicalIds.has(publicViewId(blob.key)),
  )
  const orphanUser = userBlobs.filter(
    (blob) => !canonicalIds.has(userViewId(blob.key)),
  )
  for (const blob of orphanPublic)
    issues.push({ type: 'orphan-public-view', key: blob.key })
  for (const blob of orphanHidden)
    issues.push({ type: 'orphan-hidden-view', key: blob.key })
  for (const blob of orphanUser)
    issues.push({ type: 'orphan-user-view', key: blob.key })
  if (fix) {
    await Promise.all([
      ...orphanPublic.map((blob) => data.delete(blob.key)),
      ...orphanHidden.map((blob) => data.delete(blob.key)),
      ...orphanUser.map((blob) => data.delete(blob.key)),
    ])
  }

  const date = shanghaiDateString(Date.now())
  const dateBlobs = await listEvery(data, blobKeys.commentsByDatePrefix(date))
  const latestItems = comments
    .filter((comment) => !comment.hidden)
    .sort((left, right) => right.id - left.id)
    .slice(0, LATEST_COMMENT_COUNT)
    .map(toCommentCard)
  const latestExpected = {
    version: COMMENT_VIEW_VERSION,
    date,
    generatedAt: Date.now(),
    todayCount: dateBlobs.length,
    items: latestItems,
    hasMore:
      comments.filter((comment) => !comment.hidden).length > latestItems.length,
    nextCursor:
      comments.filter((comment) => !comment.hidden).length >
        latestItems.length && latestItems.length > 0
        ? latestItems.at(-1).id
        : null,
  }
  const latest = await getJSON(data, blobKeys.commentsLatestView)
  if (
    !isLatestCommentView(latest) ||
    latest.date !== latestExpected.date ||
    !cardsEqual(latest.items, latestExpected.items) ||
    latest.todayCount !== latestExpected.todayCount ||
    Boolean(latest.hasMore) !== latestExpected.hasMore ||
    latest.nextCursor !== latestExpected.nextCursor
  ) {
    issues.push({ type: 'latest-view' })
  }
  if (fix) {
    await data.setJSON(blobKeys.commentsLatestView, latestExpected)
    const lock = await getJSON(data, blobKeys.commentsLatestLock)
    if (lock && Date.now() - Number(lock.createdAt || 0) > 60_000) {
      await data.delete(blobKeys.commentsLatestLock)
    }
    for (const blob of repairBlobs) {
      const marker = await getJSON(data, blob.key)
      if (marker?.deleted && !canonicalIds.has(Number(marker.commentId))) {
        await data.delete(blob.key)
      }
    }
  }

  return {
    aborted: false,
    mode: fix ? 'fix' : 'report',
    comments: comments.length,
    issues,
    repairMarkers: repairBlobs.length,
    repaired,
    orphanPublic: orphanPublic.map((blob) => blob.key),
    orphanHidden: orphanHidden.map((blob) => blob.key),
    orphanUser: orphanUser.map((blob) => blob.key),
  }
}

async function main() {
  const projectId = process.env.EDGEONE_PROJECT_ID
  const token = process.env.EDGEONE_API_TOKEN
  if (!projectId || !token) {
    throw new Error(
      '缺少环境变量:必须设置 EDGEONE_PROJECT_ID 与 EDGEONE_API_TOKEN',
    )
  }
  const args = process.argv.slice(2)
  const fix = args.includes('--fix')
  if (fix && !args.includes('--confirm-production-repair')) {
    throw new Error('写修复必须同时传入 --fix --confirm-production-repair')
  }
  const data = getStore({
    name: DATA_STORE,
    projectId,
    token,
    consistency: 'strong',
  })
  const report = await rebuildCommentViews(data, {
    fix,
    confirmProductionRepair: args.includes('--confirm-production-repair'),
  })
  console.log(JSON.stringify(report, null, 2))
  if (!fix && report.issues.length > 0) process.exitCode = 1
  if (fix) {
    const validation = await rebuildCommentViews(data)
    if (validation.issues.length > 0) process.exitCode = 1
  }
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(`检查失败:${error?.message || error}`)
    process.exitCode = 1
  })
}
