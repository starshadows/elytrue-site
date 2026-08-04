#!/usr/bin/env node
import { getStore } from '@edgeone/pages-blob'
import { blobKeys } from '../server/domain/blob-keys.js'
import { mapWithConcurrency } from '../server/lib/concurrency.js'
import { getJSON } from '../server/storage.js'

const DATA_STORE = 'elytrue-data'
const PAGE_SIZE = 500

async function listEvery(store, prefix) {
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

async function countLikes(store, commentId) {
  return (await listEvery(store, `likes/${commentId}/`)).length
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
  const commentBlobs = await listEvery(data, 'comments/')
  const differences = (
    await mapWithConcurrency(
      commentBlobs,
      async (blob) => {
        const comment = await getJSON(data, blob.key)
        if (!comment?.id) return null
        const actual = await countLikes(data, comment.id)
        const cache = await getJSON(
          data,
          blobKeys.commentLikeCountCache(comment.id),
        )
        const cached = Number.isSafeInteger(cache?.count)
          ? cache.count
          : comment.likeCountVersion === 1
            ? Math.max(0, Number(comment.likeCount) || 0)
            : null
        return actual === cached
          ? null
          : {
              key: blob.key,
              comment,
              cached,
              actual,
            }
      },
      6,
    )
  ).filter(Boolean)

  console.log(
    JSON.stringify(
      {
        comments: commentBlobs.length,
        differences: differences.map(({ comment, cached, actual }) => ({
          commentId: comment.id,
          number: comment.number ?? null,
          cached,
          actual,
          delta: actual - (cached ?? 0),
        })),
      },
      null,
      2,
    ),
  )

  if (!fix) {
    if (differences.length > 0) process.exitCode = 1
    return
  }
  for (const difference of differences) {
    const latest = await getJSON(data, difference.key)
    if (!latest) continue
    const actual = await countLikes(data, latest.id)
    await data.setJSON(blobKeys.commentLikeCountCache(latest.id), {
      commentId: latest.id,
      count: actual,
      updatedAt: Date.now(),
    })
    await data.delete(`repairs/comment-like-count/${latest.id}.json`)
  }
  console.log(`已修复 ${differences.length} 条留言的 likeCount 缓存。`)
}

main().catch((error) => {
  console.error(`检查失败:${error?.message || error}`)
  process.exitCode = 1
})
