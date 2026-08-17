import { performance } from 'node:perf_hooks'

function argument(name, fallback) {
  const prefix = `--${name}=`
  const value = process.argv
    .find((entry) => entry.startsWith(prefix))
    ?.slice(prefix.length)
  return value ?? fallback
}

function percentile(values, ratio) {
  if (values.length === 0) return null
  const sorted = values.slice().sort((left, right) => left - right)
  return sorted[
    Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)
  ]
}

function parseServerTiming(value) {
  return Object.fromEntries(
    String(value)
      .split(',')
      .map((entry) => /^\s*([^;]+);dur=([\d.]+)/u.exec(entry))
      .filter(Boolean)
      .map((match) => [match[1], Number(match[2])]),
  )
}

async function sample(url) {
  const startedAt = performance.now()
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
  })
  const responseHeaders = performance.now() - startedAt
  const text = await response.text()
  const responseComplete = performance.now() - startedAt
  if (!response.ok) throw new Error(`HTTP ${response.status}`)
  let data = null
  try {
    data = JSON.parse(text)?.data ?? null
  } catch {
    throw new Error('invalid JSON response')
  }
  return {
    responseHeaders,
    responseComplete,
    cacheStatus: response.headers.get('EO-Cache-Status') || 'Unknown',
    age: response.headers.get('Age') || '',
    functionRequestId: response.headers.get('Functions-Request-Id') || '',
    snapshotSource:
      response.headers.get('X-Elytrue-Snapshot-Source') || 'unknown',
    snapshotRevision: data?.snapshotRevision ?? null,
    snapshotGeneratedAt: data?.snapshotGeneratedAt ?? null,
    itemIds: Array.isArray(data?.items)
      ? data.items.map((item) => item?.id).filter(Number.isSafeInteger)
      : [],
    serverTiming: parseServerTiming(response.headers.get('Server-Timing')),
  }
}

const url = argument(
  'url',
  'https://elytrue.com/api/comments/public-fast?count=10',
)
const createdId = Number(argument('created-id', '0'))
const targetPairs = Number(argument('samples', '200'))
const intervalMs = Number(argument('interval', '6000'))

if (!Number.isSafeInteger(targetPairs) || targetPairs < 1) {
  throw new Error('--samples must be a positive integer')
}
if (!Number.isFinite(intervalMs) || intervalMs <= 5000) {
  throw new Error('--interval must be greater than 5000ms')
}

const pairs = []
let attempts = 0
while (pairs.length < targetPairs && attempts < targetPairs * 3) {
  await new Promise((resolve) => setTimeout(resolve, intervalMs))
  const first = await sample(url)
  const second = await sample(url)
  attempts += 1
  if (/miss/iu.test(first.cacheStatus) && /hit/iu.test(second.cacheStatus)) {
    pairs.push({ miss: first, hit: second })
  }
  process.stdout.write(
    `\rpaired MISS→HIT ${pairs.length}/${targetPairs} · probes ${attempts}`,
  )
}
process.stdout.write('\n')

function distribution(values) {
  const finite = values.filter(Number.isFinite)
  return {
    count: finite.length,
    p50: percentile(finite, 0.5),
    p95: percentile(finite, 0.95),
    p99: percentile(finite, 0.99),
  }
}

function summary(records) {
  const categories = [
    ...new Set(records.flatMap((record) => Object.keys(record.serverTiming))),
  ].sort()
  return {
    count: records.length,
    responseHeaders: distribution(
      records.map((record) => record.responseHeaders),
    ),
    responseComplete: distribution(
      records.map((record) => record.responseComplete),
    ),
    serverTiming: Object.fromEntries(
      categories.map((category) => [
        category,
        distribution(records.map((record) => record.serverTiming[category])),
      ]),
    ),
  }
}

const misses = pairs.map((pair) => pair.miss)
const hits = pairs.map((pair) => pair.hit)
const diagnostic = (record) => ({
  responseHeaders: record.responseHeaders,
  responseComplete: record.responseComplete,
  cacheStatus: record.cacheStatus,
  age: record.age,
  functionRequestId: record.functionRequestId,
  snapshotSource: record.snapshotSource,
  snapshotRevision: record.snapshotRevision,
  snapshotGeneratedAt: record.snapshotGeneratedAt,
  ...(createdId > 0
    ? { containsCreatedId: record.itemIds.includes(createdId) }
    : {}),
  itemIds: record.itemIds,
  serverTiming: record.serverTiming,
})

console.log(
  JSON.stringify(
    {
      url,
      intervalMs,
      attempts,
      pairedSamples: pairs.length,
      ...(createdId > 0 ? { createdId } : {}),
      miss: summary(misses),
      hit: summary(hits),
      diagnostics: pairs.map((pair) => ({
        miss: diagnostic(pair.miss),
        hit: diagnostic(pair.hit),
      })),
    },
    null,
    2,
  ),
)
if (pairs.length < targetPairs) process.exitCode = 1
