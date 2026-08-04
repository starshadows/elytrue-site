#!/usr/bin/env node
/**
 * rebuild-usage.mjs —— 按实际上传别名重算 Blob 空间统计(只读报告 / 显式修复)
 *
 * 用法:
 *   EDGEONE_PROJECT_ID=<项目ID> EDGEONE_API_TOKEN=<API Token> \
 *     node scripts/rebuild-usage.mjs [--fix] [--fix --confirm-production-migration]
 *
 * 背景:usage/uploads.json 的 uploadedBytes 在并发扣减下可能出现偏差,
 *   本脚本以 uploads/aliases/ 下所有别名记录(头像 + 留言图)的 size 之和为准重算。
 *   修复模式同样需要显式确认参数。
 *
 * 退出码:0 = 一致或修复完成;1 = 存在偏差未修复 / 环境变量缺失 / 错误。
 */

import { getStore } from '@edgeone/pages-blob'
import { getJSON } from '../server/storage.js'

const DATA_STORE = 'elytrue-data'
const USAGE_KEY = 'usage/uploads.json'
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

async function main() {
  const projectId = process.env.EDGEONE_PROJECT_ID
  const token = process.env.EDGEONE_API_TOKEN
  if (!projectId || !token) {
    throw new Error(
      '缺少环境变量:必须设置 EDGEONE_PROJECT_ID 与 EDGEONE_API_TOKEN 后才能运行(可先执行 npm run export:data 备份)',
    )
  }
  const args = process.argv.slice(2)
  const fix = args.includes('--fix')
  const confirm = args.includes('--confirm-production-migration')
  if (fix && !confirm) {
    throw new Error(
      '修复模式必须显式确认:请同时传入 --fix --confirm-production-migration',
    )
  }

  const data = getStore({
    name: DATA_STORE,
    projectId,
    token,
    consistency: 'strong',
  })

  const current = (await getJSON(data, USAGE_KEY)) || { uploadedBytes: 0 }
  const currentBytes = Math.max(0, Number(current.uploadedBytes || 0))

  const aliases = await listEvery(data, 'uploads/aliases/')
  const operationBlobs = [
    ...(await listEvery(data, 'operations/image-uploads/')),
    ...(await listEvery(data, 'operations/image-deletes/')),
  ]
  const repairOperations = []
  for (const blob of operationBlobs) {
    const operation = await getJSON(data, blob.key)
    if (operation?.phase === 'usage-repair-needed') {
      repairOperations.push({ key: blob.key, operation })
    }
  }
  let recomputed = 0
  let missingSize = 0
  for (const blob of aliases) {
    const alias = await getJSON(data, blob.key)
    if (Number.isFinite(Number(alias?.size))) {
      recomputed += Number(alias.size)
    } else {
      missingSize += 1
    }
  }

  console.log('==== Blob 空间统计 ====')
  console.log(
    `别名记录:${aliases.length} 条(缺 size 字段:${missingSize} 条,按 0 计)`,
  )
  console.log(`usage/uploads.json uploadedBytes:${currentBytes}`)
  console.log(`按别名重算 uploadedBytes:${recomputed}`)
  const delta = recomputed - currentBytes
  console.log(`偏差:${delta >= 0 ? '+' : ''}${delta}`)
  console.log(`待完成 usage operation:${repairOperations.length} 条`)

  if (!fix) {
    if (delta === 0 && repairOperations.length === 0) {
      console.log('统计一致,退出码 0。')
      return
    }
    console.log(
      '统计或 operation 存在待修复项,退出码 1。确认后运行 --fix --confirm-production-migration 修正。',
    )
    process.exitCode = 1
    return
  }

  if (delta === 0 && repairOperations.length === 0) {
    console.log('统计一致,无需修复。')
    return
  }
  await data.setJSON(USAGE_KEY, {
    uploadedBytes: recomputed,
    updatedAt: Date.now(),
  })
  console.log(`已重写 ${USAGE_KEY}:uploadedBytes = ${recomputed}`)
  const repairedAt = Date.now()
  for (const { key, operation } of repairOperations) {
    await data.setJSON(key, {
      ...operation,
      phase: 'committed',
      usageApplied: true,
      repairedAt,
      updatedAt: repairedAt,
      lastError: undefined,
    })
  }
  if (repairOperations.length > 0) {
    console.log(`已完成 usage operation:${repairOperations.length} 条`)
  }
}

main().catch((error) => {
  console.error(`检查失败:${error?.message || error}`)
  process.exitCode = 1
})
