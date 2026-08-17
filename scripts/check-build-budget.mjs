import { gzipSync } from 'node:zlib'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const distRoot = join(root, 'dist')
const config = JSON.parse(
  await readFile(join(root, 'config', 'repository-budgets.json'), 'utf8'),
)
const budgets = config.buildBudgets

const imageExtensions = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.svg',
  '.webp',
])
const audioExtensions = new Set(['.flac', '.m4a', '.mp3', '.ogg', '.wav'])
const videoSegmentExtensions = new Set(['.m4s', '.mp4'])
const fontExtensions = new Set(['.otf', '.ttf', '.woff', '.woff2'])
const forbiddenPath =
  /(?:^|\/)(?:cloud-functions|server|tests?|scripts?)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]*)?$|\.(?:map|pem|key)$/iu

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

async function collectFiles(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(path)))
    else files.push(path)
  }
  return files
}

function largest(records) {
  return records.reduce(
    (current, record) =>
      !current || record.size > current.size ? record : current,
    null,
  )
}

function evaluate(label, bytes, budget, failures, warnings) {
  const summary = `${label}: ${formatBytes(bytes)} / warn ${formatBytes(budget.warningBytes)} / max ${formatBytes(budget.maximumBytes)}`
  if (bytes > budget.maximumBytes) {
    failures.push(summary)
    console.error(`FAIL ${summary}`)
  } else if (bytes >= budget.warningBytes) {
    warnings.push(summary)
    console.warn(`WARN ${summary}`)
  } else {
    console.log(`PASS ${summary}`)
  }
}

const files = await collectFiles(distRoot)
const records = await Promise.all(
  files.map(async (file) => {
    const extension = extname(file).toLowerCase()
    return {
      path: relative(distRoot, file).split(sep).join('/'),
      extension,
      size: (await stat(file)).size,
      gzipSize:
        extension === '.js' || extension === '.css'
          ? gzipSync(await readFile(file), { level: 9 }).length
          : null,
    }
  }),
)
const javascript = records.filter((record) => record.extension === '.js')
const lazyMediaJavascript = javascript.filter((record) =>
  /^assets\/hls\.light-/u.test(record.path),
)
const applicationJavascript = javascript.filter(
  (record) => !lazyMediaJavascript.includes(record),
)
const styles = records.filter((record) => record.extension === '.css')
const images = records.filter((record) => imageExtensions.has(record.extension))
const audio = records.filter((record) => audioExtensions.has(record.extension))
const fonts = records.filter((record) => fontExtensions.has(record.extension))
const videoSegments = records.filter((record) =>
  videoSegmentExtensions.has(record.extension),
)
const failures = []
const warnings = []

for (const record of records.filter((item) => forbiddenPath.test(item.path))) {
  failures.push(`forbidden production output: ${record.path}`)
  console.error(`FAIL forbidden production output: ${record.path}`)
}

for (const record of javascript) {
  evaluate(
    `JS ${record.path}`,
    record.size,
    lazyMediaJavascript.includes(record)
      ? budgets.lazyMediaJavascriptFile
      : budgets.javascriptFile,
    failures,
    warnings,
  )
  console.log(`     gzip ${formatBytes(record.gzipSize)}`)
}
for (const record of styles) {
  evaluate(
    `CSS ${record.path}`,
    record.size,
    budgets.cssFile,
    failures,
    warnings,
  )
  console.log(`     gzip ${formatBytes(record.gzipSize)}`)
}

evaluate(
  'total JS',
  applicationJavascript.reduce((total, record) => total + record.size, 0),
  budgets.javascriptTotal,
  failures,
  warnings,
)
console.log(
  `     gzip ${formatBytes(applicationJavascript.reduce((total, record) => total + (record.gzipSize || 0), 0))}`,
)
evaluate(
  'total CSS',
  styles.reduce((total, record) => total + record.size, 0),
  budgets.cssTotal,
  failures,
  warnings,
)
console.log(
  `     gzip ${formatBytes(styles.reduce((total, record) => total + (record.gzipSize || 0), 0))}`,
)

const html = await readFile(join(distRoot, 'index.html'), 'utf8')
const entryPaths = [
  ...html.matchAll(/(?:src|href)="\/?(assets\/[^"]+\.(?:js|css))"/gu),
].map((match) => match[1])
const entryRecords = records.filter((record) =>
  entryPaths.includes(record.path),
)
const firstBackgroundPaths = [
  ...html.matchAll(/"preview":"\/(assets\/[^"]+\.webp)"/gu),
].map((match) => match[1])
const firstBackground = largest(
  images.filter((record) => firstBackgroundPaths.includes(record.path)),
)
const siteFont = fonts.find(
  (record) => record.path === 'res/AaWoyoudianfangLite.ttf',
)
const criticalTransfer =
  Buffer.byteLength(html) +
  entryRecords.reduce((total, record) => total + (record.gzipSize || 0), 0) +
  (firstBackground?.size || 0) +
  (siteFont?.size || 0)
evaluate(
  'critical transfer upper bound',
  criticalTransfer,
  budgets.criticalTransfer,
  failures,
  warnings,
)

for (const [label, record, budget] of [
  ['largest image', largest(images), budgets.imageFile],
  ['largest audio', largest(audio), budgets.audioFile],
  ['largest font', largest(fonts), budgets.fontFile],
  ['largest video segment', largest(videoSegments), budgets.videoSegment],
]) {
  if (!record) continue
  evaluate(`${label} (${record.path})`, record.size, budget, failures, warnings)
}

evaluate(
  'dist total',
  records.reduce((total, record) => total + record.size, 0),
  budgets.distTotal,
  failures,
  warnings,
)

if (failures.length > 0) {
  console.error(`Build budget failed with ${failures.length} violation(s).`)
  process.exitCode = 1
} else {
  console.log(
    `Build budget passed: ${records.length} files, ${warnings.length} warning(s).`,
  )
}
