#!/usr/bin/env node
import { getStore } from '@edgeone/pages-blob'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { blobKeys } from '../server/domain/blob-keys.js'
import {
  commitAvatarUpdate,
  compensateAvatarUpdate,
  deleteAvatar,
  UPLOAD_WARNING_BYTES,
} from '../server/services/image-service.js'
import { getJSON } from '../server/storage.js'

const PAGE_SIZE = 500
const STALE_PENDING_MS = 24 * 60 * 60 * 1000
const TERMINAL_PHASES = new Set(['committed', 'rolled-back'])

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

async function loadRecords(store, prefixes) {
  const groups = await Promise.all(
    prefixes.map((prefix) => listEvery(store, prefix)),
  )
  const blobs = groups.flat()
  return Promise.all(
    blobs.map(async (blob) => ({
      key: blob.key,
      value: await getJSON(store, blob.key),
    })),
  )
}

function imageIdFromAliasKey(key) {
  return key.slice(key.lastIndexOf('/') + 1, -'.json'.length)
}

async function collectInventory(data, uploads, now) {
  const [
    aliasRecords,
    physicalGroups,
    operationRecords,
    users,
    repairs,
    usage,
  ] = await Promise.all([
    loadRecords(data, [
      'uploads/aliases/avatars/',
      'uploads/aliases/comments/',
    ]),
    Promise.all([
      listEvery(uploads, 'avatars/'),
      listEvery(uploads, 'comments/'),
    ]),
    loadRecords(data, [
      'operations/image-uploads/',
      'operations/image-deletes/',
      'operations/avatar-updates/',
      'operations/avatar-deletes/',
    ]),
    loadRecords(data, ['users/']),
    loadRecords(data, ['repairs/avatar-update/']),
    getJSON(data, blobKeys.uploadUsage),
  ])
  const physicalBlobs = physicalGroups.flat()
  const physicalKeys = new Set(physicalBlobs.map((blob) => blob.key))
  const aliases = aliasRecords.map((record) => ({
    ...record,
    imageId: record.value?.imageId || imageIdFromAliasKey(record.key),
    kind: record.key.includes('/avatars/') ? 'avatar' : 'comment',
  }))
  const aliasBlobKeys = new Set(
    aliases.map((record) => record.value?.blobKey).filter(Boolean),
  )
  const usersById = new Map(
    users
      .filter((record) => record.value?.id)
      .map((record) => [record.value.id, record]),
  )
  const avatarReferences = new Map()
  for (const record of users) {
    const imageId = String(record.value?.avatarKey || '')
    if (!imageId) continue
    const referenced = avatarReferences.get(imageId) || []
    referenced.push(record)
    avatarReferences.set(imageId, referenced)
  }
  const avatarAliases = aliases.filter((record) => record.kind === 'avatar')
  const aliasesByImageId = new Map(
    avatarAliases.map((record) => [record.imageId, record]),
  )
  const danglingAliases = aliases.filter(
    (record) =>
      record.value?.blobKey && !physicalKeys.has(record.value.blobKey),
  )
  const orphanBlobs = [...physicalKeys].filter((key) => !aliasBlobKeys.has(key))
  const invalidAliases = aliases.filter(
    (record) =>
      !record.value?.blobKey ||
      !record.value?.userId ||
      !Number.isFinite(Number(record.value?.size)) ||
      Number(record.value?.size) < 0 ||
      (record.kind === 'avatar' &&
        !['active', 'pending'].includes(record.value?.status)),
  )
  const invalidAvatarOwnership = avatarAliases.flatMap((record) =>
    (avatarReferences.get(record.imageId) || [])
      .filter((userRecord) => userRecord.value?.id !== record.value?.userId)
      .map((userRecord) => ({ imageId: record.imageId, userRecord })),
  )
  const referencedPendingAvatars = avatarAliases.filter(
    (record) =>
      record.value?.status === 'pending' &&
      avatarReferences.has(record.imageId),
  )
  const stalePendingAvatars = avatarAliases.filter(
    (record) =>
      record.value?.status === 'pending' &&
      !avatarReferences.has(record.imageId) &&
      Number(record.value?.createdAt || 0) <= now - STALE_PENDING_MS,
  )
  const unreferencedActiveAvatars = avatarAliases.filter(
    (record) =>
      record.value?.status === 'active' &&
      !avatarReferences.has(record.imageId),
  )
  const missingAvatarAliases = [...avatarReferences].filter(
    ([imageId]) => !aliasesByImageId.has(imageId),
  )
  const aliasBytes = aliases.reduce(
    (sum, record) =>
      Number.isFinite(Number(record.value?.size))
        ? sum + Number(record.value.size)
        : sum,
    0,
  )
  const usageBytes = Math.max(0, Number(usage?.uploadedBytes || 0))
  const openOperationRecords = operationRecords.filter(
    (record) => record.value && !TERMINAL_PHASES.has(record.value.phase),
  )

  return {
    aliases,
    aliasBytes,
    avatarReferences,
    danglingAliases,
    invalidAliases,
    invalidAvatarOwnership,
    missingAvatarAliases,
    openOperationRecords,
    operationRecords,
    orphanBlobs,
    physicalBlobs,
    physicalKeys,
    referencedPendingAvatars,
    repairs,
    stalePendingAvatars,
    unreferencedActiveAvatars,
    usage,
    usageBytes,
    usersById,
  }
}

function reportFromInventory(inventory, repaired = 0) {
  return {
    aliases: inventory.aliases.length,
    physicalBlobs: inventory.physicalBlobs.length,
    aliasBytes: inventory.aliasBytes,
    usageBytes: inventory.usageBytes,
    usageDelta: inventory.usageBytes - inventory.aliasBytes,
    danglingAliases: inventory.danglingAliases.map(
      (record) => record.imageId || record.value?.blobKey,
    ),
    orphanBlobs: inventory.orphanBlobs,
    invalidAliases: inventory.invalidAliases.map(
      (record) => record.imageId || record.value?.blobKey || 'unknown',
    ),
    invalidAvatarOwnership: inventory.invalidAvatarOwnership.map(
      (item) => `${item.userRecord.value.id}:${item.imageId}`,
    ),
    missingAvatarAliases: inventory.missingAvatarAliases.map(
      ([imageId]) => imageId,
    ),
    referencedPendingAvatars: inventory.referencedPendingAvatars.map(
      (record) => record.imageId,
    ),
    stalePendingAvatars: inventory.stalePendingAvatars.map(
      (record) => record.imageId,
    ),
    unreferencedActiveAvatars: inventory.unreferencedActiveAvatars.map(
      (record) => record.imageId,
    ),
    openOperations: inventory.openOperationRecords.map((record) => ({
      operationId: record.value.operationId,
      imageId: record.value.imageId || record.value.newAvatarId,
      phase: record.value.phase,
    })),
    repairMarkers: inventory.repairs.map(
      (record) => record.value?.operationId || record.key,
    ),
    repaired,
  }
}

function reportHasFindings(report) {
  return (
    report.usageDelta !== 0 ||
    report.danglingAliases.length > 0 ||
    report.orphanBlobs.length > 0 ||
    report.invalidAliases.length > 0 ||
    report.invalidAvatarOwnership.length > 0 ||
    report.missingAvatarAliases.length > 0 ||
    report.referencedPendingAvatars.length > 0 ||
    report.stalePendingAvatars.length > 0 ||
    report.unreferencedActiveAvatars.length > 0 ||
    report.openOperations.length > 0 ||
    report.repairMarkers.length > 0
  )
}

async function setUserAvatar(data, record, avatarKey, now) {
  await data.setJSON(record.key, {
    ...record.value,
    avatarKey,
    recoveryKeyVersion: Number(record.value.recoveryKeyVersion || 0) + 1,
    lastUserMutationId: `avatar-audit-${now}`,
    updatedAt: now,
  })
}

async function repairInventory(data, uploads, inventory, now) {
  let repaired = 0

  for (const record of inventory.referencedPendingAvatars) {
    if (!inventory.physicalKeys.has(record.value.blobKey)) continue
    await data.setJSON(record.key, {
      ...record.value,
      status: 'active',
      activatedAt: now,
    })
    repaired += 1
  }

  for (const record of inventory.danglingAliases) {
    if (record.kind === 'avatar') {
      for (const userRecord of inventory.avatarReferences.get(record.imageId) ||
        []) {
        await setUserAvatar(data, userRecord, '', now)
        repaired += 1
      }
    }
    await data.delete(record.key)
    if (record.value?.blobKey) await uploads.delete(record.value.blobKey)
    repaired += 1
  }

  for (const record of inventory.invalidAliases) {
    if (inventory.danglingAliases.includes(record)) continue
    if (record.kind === 'avatar') {
      for (const userRecord of inventory.avatarReferences.get(record.imageId) ||
        []) {
        await setUserAvatar(data, userRecord, '', now)
        repaired += 1
      }
    }
    await data.delete(record.key)
    if (record.value?.blobKey) await uploads.delete(record.value.blobKey)
    repaired += 1
  }

  for (const [imageId, userRecords] of inventory.missingAvatarAliases) {
    for (const userRecord of userRecords) {
      await setUserAvatar(data, userRecord, '', now)
      repaired += 1
    }
    void imageId
  }

  for (const item of inventory.invalidAvatarOwnership) {
    await setUserAvatar(data, item.userRecord, '', now)
    repaired += 1
  }
  for (const imageId of new Set(
    inventory.invalidAvatarOwnership.map((item) => item.imageId),
  )) {
    const alias = inventory.aliases.find(
      (record) => record.kind === 'avatar' && record.imageId === imageId,
    )
    const hasOwnedReference = (
      inventory.avatarReferences.get(imageId) || []
    ).some((record) => record.value?.id === alias?.value?.userId)
    if (alias && !hasOwnedReference) {
      await deleteAvatar({ data, uploads }, alias.value.userId, imageId)
      repaired += 1
    }
  }

  const avatarsToDelete = [
    ...inventory.stalePendingAvatars,
    ...inventory.unreferencedActiveAvatars,
  ]
  const pendingOperationImages = new Set(
    inventory.openOperationRecords
      .filter((record) => record.key.startsWith('operations/avatar-updates/'))
      .map((record) => record.value?.newAvatarId)
      .filter(Boolean),
  )
  for (const record of avatarsToDelete) {
    if (inventory.danglingAliases.includes(record)) continue
    if (pendingOperationImages.has(record.imageId)) continue
    await deleteAvatar({ data, uploads }, record.value.userId, record.imageId)
    repaired += 1
  }

  for (const key of inventory.orphanBlobs) {
    await uploads.delete(key)
    repaired += 1
  }

  for (const record of inventory.openOperationRecords) {
    const operation = await getJSON(data, record.key)
    if (!operation || TERMINAL_PHASES.has(operation.phase)) continue
    if (record.key.startsWith('operations/avatar-updates/')) {
      const user = inventory.usersById.get(operation.userId)?.value
      if (user?.avatarKey === operation.newAvatarId) {
        const alias = operation.newAvatarId
          ? await getJSON(
              data,
              blobKeys.imageAlias('avatar', operation.newAvatarId),
            )
          : null
        const blob = alias?.blobKey
          ? await uploads.get(alias.blobKey, {
              type: 'arrayBuffer',
              consistency: 'strong',
            })
          : null
        if (!operation.newAvatarId || (alias && blob)) {
          await commitAvatarUpdate({ data, uploads }, operation, user)
          repaired += 1
          continue
        }
        const oldAlias = operation.oldAvatarId
          ? await getJSON(
              data,
              blobKeys.imageAlias('avatar', operation.oldAvatarId),
            )
          : null
        const oldBlob = oldAlias?.blobKey
          ? await uploads.get(oldAlias.blobKey, {
              type: 'arrayBuffer',
              consistency: 'strong',
            })
          : null
        const userRecord = inventory.usersById.get(operation.userId)
        if (userRecord) {
          await setUserAvatar(
            data,
            userRecord,
            oldAlias?.status === 'active' && oldBlob
              ? operation.oldAvatarId
              : '',
            now,
          )
        }
      }
      await compensateAvatarUpdate({ data, uploads }, operation)
      repaired += 1
      continue
    }
    if (record.key.startsWith('operations/avatar-deletes/')) {
      const referenced = [...inventory.avatarReferences].some(
        ([imageId]) => imageId === operation.imageId,
      )
      if (!referenced) {
        await deleteAvatar(
          { data, uploads },
          operation.userId,
          operation.imageId,
        )
        repaired += 1
      }
      continue
    }

    const aliasKind = operation.kind === 'avatar' ? 'avatar' : 'comment'
    const alias = operation.imageId
      ? await getJSON(data, blobKeys.imageAlias(aliasKind, operation.imageId))
      : null
    const blob = operation.blobKey
      ? await uploads.get(operation.blobKey, {
          type: 'arrayBuffer',
          consistency: 'strong',
        })
      : null
    const desiredPresent = operation.desiredState === 'present'
    if (
      (desiredPresent && alias && blob) ||
      (!desiredPresent && !alias && !blob)
    ) {
      await data.setJSON(record.key, {
        ...operation,
        phase: 'committed',
        usageApplied: true,
        lastError: null,
        repairedAt: now,
        updatedAt: now,
      })
      repaired += 1
    } else if (desiredPresent && !alias && !blob) {
      await data.setJSON(record.key, {
        ...operation,
        phase: 'rolled-back',
        usageApplied: false,
        lastError: null,
        repairedAt: now,
        updatedAt: now,
      })
      repaired += 1
    }
  }

  for (const repair of inventory.repairs) {
    const operationId = repair.value?.operationId
    if (!operationId) continue
    const operation = await getJSON(
      data,
      blobKeys.avatarUpdateOperation(operationId),
    )
    if (operation && TERMINAL_PHASES.has(operation.phase)) {
      await data.delete(repair.key)
      repaired += 1
    }
  }

  const finalAliases = await loadRecords(data, [
    'uploads/aliases/avatars/',
    'uploads/aliases/comments/',
  ])
  let uploadedBytes = 0
  for (const record of finalAliases) {
    if (!record.value?.blobKey || !Number.isFinite(Number(record.value?.size)))
      continue
    const blob = await uploads.get(record.value.blobKey, {
      type: 'arrayBuffer',
      consistency: 'strong',
    })
    if (blob) uploadedBytes += Number(record.value.size)
  }
  const currentUsage = (await getJSON(data, blobKeys.uploadUsage)) || {}
  const finalOperations = await loadRecords(data, [
    'operations/image-uploads/',
    'operations/image-deletes/',
    'operations/avatar-updates/',
    'operations/avatar-deletes/',
  ])
  const canCompactAdjustments = finalOperations.every(
    (record) => !record.value || TERMINAL_PHASES.has(record.value.phase),
  )
  await data.setJSON(blobKeys.uploadUsage, {
    ...currentUsage,
    uploadedBytes,
    ...(canCompactAdjustments ? { adjustments: {} } : {}),
    updatedAt: now,
    warning: uploadedBytes >= UPLOAD_WARNING_BYTES,
  })
  if (uploadedBytes !== inventory.usageBytes) repaired += 1
  return repaired
}

export async function auditUploadStorage(data, uploads, options = {}) {
  const now = options.now ?? Date.now()
  const inventory = await collectInventory(data, uploads, now)
  if (!options.fix) return reportFromInventory(inventory)
  const repaired = await repairInventory(data, uploads, inventory, now)
  const finalInventory = await collectInventory(data, uploads, now)
  return reportFromInventory(finalInventory, repaired)
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
      '修复模式必须先完成备份、停止头像写入，并传入 --fix --confirm-production-repair',
    )
  }

  const data = getStore({
    name: 'elytrue-data',
    projectId,
    token,
    consistency: 'strong',
  })
  const uploads = getStore({
    name: 'elytrue-uploads',
    projectId,
    token,
    consistency: 'strong',
  })
  const report = await auditUploadStorage(data, uploads, { fix })
  console.log(JSON.stringify(report, null, 2))
  if (reportHasFindings(report)) process.exitCode = 1
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])
if (isMain) {
  main().catch((error) => {
    console.error(`审计失败:${error?.message || error}`)
    process.exitCode = 1
  })
}
