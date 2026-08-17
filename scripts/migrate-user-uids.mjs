#!/usr/bin/env node

import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { getStore } from '@edgeone/pages-blob'
import { blobKeys, blobPrefixes } from '../server/domain/blob-keys.js'
import { getJSON, isPreconditionFailure } from '../server/storage.js'

const DATA_STORE = 'elytrue-data'
const PAGE_SIZE = 500
const USER_ID_PATTERN = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/iu

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

function compareUsers(left, right) {
  const timeDifference = Number(left.createdAt) - Number(right.createdAt)
  if (timeDifference) return timeDifference
  const leftId = String(left.id)
  const rightId = String(right.id)
  return leftId < rightId ? -1 : leftId > rightId ? 1 : 0
}

function parseSeatNumber(key) {
  const match = /^indexes\/users\/uid\/(\d+)\.json$/u.exec(key)
  return match ? Number(match[1]) : null
}

export async function migrateUserUids(data, options = {}) {
  const fix = options.fix === true
  const confirmed = options.confirmProductionMigration === true
  if (fix && !confirmed) {
    return {
      aborted: true,
      mode: 'fix',
      reason: 'missing-confirm',
      issues: [],
      planned: [],
    }
  }

  const userBlobs = await listEvery(data, blobPrefixes.users)
  const users = []
  const issues = []
  const seenUserIds = new Set()
  for (const blob of userBlobs) {
    const user = await getJSON(data, blob.key)
    if (!user || !USER_ID_PATTERN.test(String(user.id || ''))) {
      issues.push({ type: 'invalid-user', key: blob.key })
      continue
    }
    if (blob.key !== blobKeys.user(user.id)) {
      issues.push({ type: 'user-key-mismatch', key: blob.key, userId: user.id })
      continue
    }
    if (seenUserIds.has(user.id)) {
      issues.push({ type: 'duplicate-user-id', userId: user.id })
      continue
    }
    seenUserIds.add(user.id)
    if (
      typeof user.createdAt !== 'number' ||
      !Number.isFinite(user.createdAt)
    ) {
      issues.push({ type: 'invalid-created-at', userId: user.id })
      continue
    }
    users.push(user)
  }
  users.sort(compareUsers)

  const seatBlobs = await listEvery(data, blobPrefixes.userUids)
  const seats = new Map()
  for (const blob of seatBlobs) {
    const uid = parseSeatNumber(blob.key)
    const seat = uid === null ? null : await getJSON(data, blob.key)
    if (
      !uid ||
      !seat?.userId ||
      seat.uid !== uid ||
      (seat.status !== 'reserved' && seat.status !== 'committed')
    ) {
      issues.push({ type: 'invalid-seat', key: blob.key })
      continue
    }
    seats.set(uid, seat)
  }

  const expectedByUser = new Map()
  const seenExistingUids = new Map()
  const planned = []
  users.forEach((user, index) => {
    const expectedUid = index + 1
    expectedByUser.set(user.id, expectedUid)
    if (user.uid !== undefined) {
      if (!Number.isSafeInteger(user.uid) || user.uid <= 0) {
        issues.push({
          type: 'invalid-user-uid',
          userId: user.id,
          uid: user.uid,
        })
      } else if (user.uid !== expectedUid) {
        issues.push({
          type: 'uid-order-conflict',
          userId: user.id,
          uid: user.uid,
          expectedUid,
        })
      }
      const previousOwner = seenExistingUids.get(user.uid)
      if (previousOwner && previousOwner !== user.id) {
        issues.push({
          type: 'duplicate-user-uid',
          uid: user.uid,
          userIds: [previousOwner, user.id],
        })
      }
      seenExistingUids.set(user.uid, user.id)
    }
    const seat = seats.get(expectedUid)
    if (seat && seat.userId !== user.id) {
      issues.push({
        type: 'seat-owner-conflict',
        uid: expectedUid,
        userId: user.id,
        seatUserId: seat.userId,
      })
    }
    if (user.uid === undefined || !seat || seat.status !== 'committed') {
      planned.push({ userId: user.id, uid: expectedUid })
    }
  })

  for (const [uid, seat] of seats) {
    const expectedUid = expectedByUser.get(seat.userId)
    if (expectedUid === undefined) {
      issues.push({ type: 'orphan-seat', uid, seatUserId: seat.userId })
    } else if (expectedUid !== uid) {
      issues.push({
        type: 'seat-number-conflict',
        uid,
        seatUserId: seat.userId,
        expectedUid,
      })
    }
  }

  if (issues.length) {
    return {
      aborted: true,
      mode: fix ? 'fix' : 'report',
      reason: 'inconsistent-data',
      issues,
      planned,
    }
  }
  if (!fix) {
    return { aborted: false, mode: 'report', issues, planned }
  }

  let changed = 0
  for (let index = 0; index < users.length; index += 1) {
    const user = users[index]
    const uid = index + 1
    const key = blobKeys.userUid(uid)
    let seat = seats.get(uid)
    let createdSeat = false
    if (!seat) {
      const now = Date.now()
      const nextSeat = {
        uid,
        userId: user.id,
        reservationId: `migration:${user.id}`,
        status: 'committed',
        source: 'created-at-migration',
        createdAt: Number(user.createdAt),
        committedAt: now,
      }
      try {
        await data.setJSON(key, nextSeat, { onlyIfNew: true })
        createdSeat = true
      } catch (error) {
        if (!isPreconditionFailure(error)) throw error
      }
      seat = await getJSON(data, key)
      if (seat?.userId !== user.id) {
        throw new Error(`UID ${uid} seat ownership changed during migration`)
      }
      changed += createdSeat ? 1 : 0
    }

    if (seat.status !== 'committed') {
      const current = await getJSON(data, key)
      if (current?.userId !== user.id) {
        throw new Error(`UID ${uid} seat ownership changed during migration`)
      }
      await data.setJSON(key, {
        ...current,
        status: 'committed',
        committedAt: Date.now(),
        source: current.source || 'created-at-migration',
      })
      seat = await getJSON(data, key)
      if (seat?.userId !== user.id || seat?.status !== 'committed') {
        throw new Error(
          `UID ${uid} seat could not be committed during migration`,
        )
      }
      changed += 1
    }

    if (user.uid === uid) continue
    try {
      await data.setJSON(blobKeys.user(user.id), {
        ...user,
        uid,
        updatedAt: Date.now(),
      })
      changed += 1
    } catch (error) {
      if (createdSeat) {
        const current = await getJSON(data, key).catch(() => null)
        if (current?.reservationId === `migration:${user.id}`) {
          await data.delete(key).catch(() => {})
        }
      }
      throw error
    }
  }

  const maximumUid = users.length
  const hint = await getJSON(data, blobKeys.userUidHint)
  if (hint?.value !== maximumUid) {
    await data.setJSON(blobKeys.userUidHint, {
      value: maximumUid,
      updatedAt: Date.now(),
      source: 'created-at-migration',
    })
    changed += 1
  }
  const schema = await getJSON(data, blobKeys.userUidSchema)
  if (schema?.version !== 1 || schema?.status !== 'ready') {
    await data.setJSON(blobKeys.userUidSchema, {
      version: 1,
      status: 'ready',
      migratedAt: Date.now(),
      migratedUsers: users.length,
      source: 'created-at-migration',
    })
    changed += 1
  }

  return {
    aborted: false,
    mode: 'fix',
    issues: [],
    planned,
    changed,
    maximumUid,
  }
}

async function main() {
  const projectId = process.env.EDGEONE_PROJECT_ID
  const token = process.env.EDGEONE_API_TOKEN
  if (!projectId || !token) {
    throw new Error(
      '缺少环境变量：必须设置 EDGEONE_PROJECT_ID 与 EDGEONE_API_TOKEN；运行修复前请先备份并暂停注册和资料写入',
    )
  }
  const fix = process.argv.includes('--fix')
  const confirmProductionMigration = process.argv.includes(
    '--confirm-production-migration',
  )
  const data = getStore({
    name: DATA_STORE,
    projectId,
    token,
    consistency: 'strong',
  })
  const result = await migrateUserUids(data, {
    fix,
    confirmProductionMigration,
  })
  console.log(JSON.stringify(result, null, 2))
  if (result.aborted || (!fix && result.planned.length > 0))
    process.exitCode = 1
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])
) {
  main().catch((error) => {
    console.error(error)
    process.exitCode = 1
  })
}
