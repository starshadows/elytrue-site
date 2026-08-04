#!/usr/bin/env node

import { getStore } from '@edgeone/pages-blob'
import { getJSON, listAll } from '../server/storage.js'

const DATA_STORE = 'elytrue-data'
const CLAIM_PREFIX = 'recovery-key-claims/'
const MINIMUM_AGE_MS = 5 * 60 * 1000
const FIX = process.argv.includes('--fix')
const CONFIRMED = process.argv.includes('--confirm-production-repair')

function parseClaimKey(key) {
  const match = /^recovery-key-claims\/([^/]+)\/(\d+)\.json$/u.exec(key)
  return match ? { userId: match[1], version: Number(match[2]) } : null
}

async function main() {
  const projectId = process.env.EDGEONE_PROJECT_ID
  const token = process.env.EDGEONE_API_TOKEN
  if (!projectId || !token) {
    throw new Error(
      '缺少环境变量:必须设置 EDGEONE_PROJECT_ID 与 EDGEONE_API_TOKEN',
    )
  }
  if (FIX && !CONFIRMED) {
    throw new Error(
      '--fix 必须同时传入 --confirm-production-repair,并先暂停账号写入流量',
    )
  }

  const data = getStore({
    name: DATA_STORE,
    projectId,
    token,
    consistency: 'strong',
  })
  const blobs = await listAll(data, CLAIM_PREFIX, Infinity)
  const now = Date.now()
  const repairable = []
  const suspicious = []

  for (const blob of blobs) {
    const parsed = parseClaimKey(blob.key)
    const claim = parsed ? await getJSON(data, blob.key) : null
    if (!parsed || !claim) {
      suspicious.push({ key: blob.key, reason: 'key 或内容无效' })
      continue
    }
    const age = now - Number(claim.claimedAt || 0)
    const user = await getJSON(data, `users/${parsed.userId}.json`)
    const currentVersion = Number(user?.recoveryKeyVersion || 0)
    if (age < MINIMUM_AGE_MS) continue
    if (!user || parsed.version <= currentVersion) {
      repairable.push({
        ...parsed,
        key: blob.key,
        reservationId: claim.reservationId,
        claimedAt: claim.claimedAt,
        currentVersion: user ? currentVersion : null,
        reason: !user
          ? '用户不存在'
          : parsed.version === currentVersion
            ? '当前版本占位超过函数执行上限'
            : '已推进版本的清理残留',
      })
    } else {
      suspicious.push({
        key: blob.key,
        reason: `claim 版本 ${parsed.version} 高于用户版本 ${currentVersion}`,
      })
    }
  }

  console.log(
    `扫描 ${blobs.length} 个用户 mutation claims,可修复 ${repairable.length} 个,异常 ${suspicious.length} 个`,
  )
  for (const item of repairable) {
    console.log(`[可修复] ${item.key}: ${item.reason}`)
  }
  for (const item of suspicious) {
    console.log(`[跳过] ${item.key}: ${item.reason}`)
  }

  if (!FIX) return
  for (const item of repairable) {
    const current = await getJSON(data, item.key)
    if (
      current?.reservationId !== item.reservationId ||
      current?.claimedAt !== item.claimedAt
    ) {
      console.log(`[跳过变化项] ${item.key}`)
      continue
    }
    await data.delete(item.key)
    console.log(`[已删除] ${item.key}`)
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
