#!/usr/bin/env node
import { getStore } from '@edgeone/pages-blob'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blobKeys } from '../server/domain/blob-keys.js'
import { getJSON } from '../server/storage.js'
import {
  refreshLatestCommentView,
  writeCommentViews,
} from '../server/services/comment-view-service.js'
import { shanghaiDateString } from '../server/comments.js'

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
    const pageBlobs = page.blobs || []
    blobs.push(...pageBlobs)
    const nextCursor = page.cursor
    if (!nextCursor || nextCursor === cursor || pageBlobs.length < PAGE_SIZE)
      break
    cursor = nextCursor
  } while (true)
  return blobs
}

export async function countLikes(store, commentId) {
  return (await listEvery(store, `likes/${commentId}/`)).length
}

export async function auditCommentLikes(data, { fix = false } = {}) {
  const commentBlobs = await listEvery(data, 'comments/')
  const commentIds = new Set()
  const differences = []
  const corruption = []
  for (const blob of commentBlobs) {
    const keyMatch = /^comments\/(\d{16})\.json$/u.exec(String(blob.key))
    const comment = await getJSON(data, blob.key)
    const keyId = keyMatch ? Number(keyMatch[1]) : null
    if (!keyId || comment?.id !== keyId) {
      corruption.push({ key: blob.key, commentId: comment?.id ?? null })
      continue
    }
    commentIds.add(keyId)
    const actual = await countLikes(data, keyId)
    const cached = Number.isSafeInteger(comment.likes)
      ? Math.max(0, comment.likes)
      : null
    if (actual !== cached)
      differences.push({ key: blob.key, comment, cached, actual })
  }

  const likeBlobs = await listEvery(data, 'likes/')
  const orphanFacts = likeBlobs
    .map((blob) => /^likes\/(\d+)\/[^/]+\.json$/u.exec(String(blob.key))?.[1])
    .filter((id) => id && !commentIds.has(Number(id)))
    .map((id) => Number(id))
  const markerBlobs = await listEvery(data, 'repairs/comment-views/')
  const markers = []
  for (const blob of markerBlobs) {
    const marker = await getJSON(data, blob.key)
    const id = Number(marker?.commentId)
    if (!Number.isSafeInteger(id) || id <= 0 || !commentIds.has(id)) {
      markers.push({
        key: blob.key,
        commentId: marker?.commentId ?? null,
        orphan: true,
      })
    } else {
      markers.push({
        key: blob.key,
        commentId: id,
        orphan: false,
        reason: marker.reason || null,
      })
    }
  }

  const report = {
    comments: commentBlobs.length,
    differences,
    corruption,
    orphanFacts: [...new Set(orphanFacts)],
    markers,
    repaired: 0,
  }
  if (fix) {
    for (const difference of differences) {
      const latest = await getJSON(data, difference.key)
      if (!latest || latest.id !== difference.comment.id) continue
      const actual = await countLikes(data, latest.id)
      latest.likes = actual
      latest.updatedAt = Date.now()
      await data.setJSON(difference.key, latest)
      await writeCommentViews(data, latest)
      await data.delete(blobKeys.commentViewRepair(latest.id))
      report.repaired += 1
    }
    for (const marker of markers.filter(
      (item) => !item.orphan && item.reason === 'like',
    )) {
      const difference = report.differences.find(
        (item) => item.comment.id === marker.commentId,
      )
      if (!difference) {
        const cache = await getJSON(data, blobKeys.comment(marker.commentId))
        const actual = await countLikes(data, marker.commentId)
        if (Number.isSafeInteger(cache?.likes) && cache.likes === actual) {
          await data.delete(marker.key)
          report.repaired += 1
        }
      }
    }
    await refreshLatestCommentView(data, shanghaiDateString(Date.now()))
  }
  return report
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
    throw new Error(
      '修复前请停止写入并备份，然后同时传入 --fix --confirm-production-repair',
    )
  }

  const data = getStore({
    name: DATA_STORE,
    projectId,
    token,
    consistency: 'strong',
  })
  const report = await auditCommentLikes(data, { fix })

  console.log(
    JSON.stringify(
      {
        comments: report.comments,
        differences: report.differences.map(({ comment, cached, actual }) => ({
          commentId: comment.id,
          number: comment.number ?? null,
          cached,
          actual,
          delta: actual - (cached ?? 0),
        })),
        corruption: report.corruption,
        orphanFacts: report.orphanFacts,
        markers: report.markers,
      },
      null,
      2,
    ),
  )

  if (!fix) {
    if (
      report.differences.length > 0 ||
      report.corruption.length > 0 ||
      report.orphanFacts.length > 0 ||
      report.markers.some((marker) => marker.orphan)
    )
      process.exitCode = 1
    return
  }
  console.log(`已修复 ${report.repaired} 条留言的 likeCount 缓存。`)
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(`检查失败:${error?.message || error}`)
    process.exitCode = 1
  })
}
