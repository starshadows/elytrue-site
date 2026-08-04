#!/usr/bin/env node
import { getStore } from '@edgeone/pages-blob'
import { getJSON } from '../server/storage.js'

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
    blobs.push(...(page.blobs || []))
    cursor = page.cursor || null
  } while (cursor)
  return blobs
}

async function main() {
  const projectId = process.env.EDGEONE_PROJECT_ID
  const token = process.env.EDGEONE_API_TOKEN
  if (!projectId || !token) {
    throw new Error(
      '缺少环境变量:必须设置 EDGEONE_PROJECT_ID 与 EDGEONE_API_TOKEN',
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
  const [aliasBlobs, physicalBlobs, operationBlobs, usage] = await Promise.all([
    Promise.all([
      listEvery(data, 'uploads/aliases/avatars/'),
      listEvery(data, 'uploads/aliases/comments/'),
    ]).then((groups) => groups.flat()),
    Promise.all([
      listEvery(uploads, 'avatars/'),
      listEvery(uploads, 'comments/'),
    ]).then((groups) => groups.flat()),
    Promise.all([
      listEvery(data, 'operations/image-uploads/'),
      listEvery(data, 'operations/image-deletes/'),
    ]).then((groups) => groups.flat()),
    getJSON(data, 'usage/uploads.json'),
  ])

  const aliases = await Promise.all(
    aliasBlobs.map((blob) => getJSON(data, blob.key)),
  )
  const physicalKeys = new Set(physicalBlobs.map((blob) => blob.key))
  const aliasKeys = new Set(
    aliases.map((alias) => alias?.blobKey).filter(Boolean),
  )
  const danglingAliases = aliases.filter(
    (alias) => alias?.blobKey && !physicalKeys.has(alias.blobKey),
  )
  const orphanBlobs = [...physicalKeys].filter((key) => !aliasKeys.has(key))
  const invalidAliases = aliases.filter(
    (alias) =>
      !alias?.blobKey ||
      !alias?.userId ||
      !Number.isFinite(Number(alias?.size)) ||
      Number(alias?.size) < 0,
  )
  const aliasBytes = aliases.reduce(
    (sum, alias) =>
      Number.isFinite(Number(alias?.size)) ? sum + Number(alias.size) : sum,
    0,
  )
  const usageBytes = Math.max(0, Number(usage?.uploadedBytes || 0))
  const operations = await Promise.all(
    operationBlobs.map((blob) => getJSON(data, blob.key)),
  )
  const openOperations = operations.filter(
    (operation) =>
      operation && !['committed', 'rolled-back'].includes(operation.phase),
  )

  const report = {
    aliases: aliases.length,
    physicalBlobs: physicalBlobs.length,
    aliasBytes,
    usageBytes,
    usageDelta: usageBytes - aliasBytes,
    danglingAliases: danglingAliases.map(
      (alias) => alias.imageId || alias.blobKey,
    ),
    orphanBlobs,
    invalidAliases: invalidAliases.map(
      (alias) => alias?.imageId || alias?.blobKey || 'unknown',
    ),
    openOperations: openOperations.map((operation) => ({
      operationId: operation.operationId,
      imageId: operation.imageId,
      phase: operation.phase,
    })),
  }
  console.log(JSON.stringify(report, null, 2))
  if (
    report.usageDelta !== 0 ||
    report.danglingAliases.length > 0 ||
    report.orphanBlobs.length > 0 ||
    report.invalidAliases.length > 0 ||
    report.openOperations.length > 0
  ) {
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error(`审计失败:${error?.message || error}`)
  process.exitCode = 1
})
