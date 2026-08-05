import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const publicRoot = join(root, 'public')
const budgetConfig = JSON.parse(
  await readFile(join(root, 'config', 'repository-budgets.json'), 'utf8'),
)
const budgets = budgetConfig.assetBudgets
const reportRequested = process.argv.includes('--report')
const textExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.md',
  '.scss',
  '.ts',
  '.vue',
])
const sourceRoots = ['index.html', 'src', 'public/index.manifest.json']
const deployedSourceRoots = [
  'index.html',
  'src',
  'public',
  'server',
  'cloud-functions',
  'shared',
  'middleware.js',
  'edgeone.json',
  'vite.config.ts',
]
const forbiddenLegacyMarkers = [
  ['yume', 'niwa'].join(''),
  ['haojiezhe12345', '.top'].join(''),
  ['madohomu', '.love'].join(''),
  ['yume', 'niwa.', 'madohomu', '.love'].join(''),
]
const failures = []
const notices = []
const warnings = []
const imageExtensions = new Set([
  '.avif',
  '.gif',
  '.ico',
  '.jpeg',
  '.jpg',
  '.png',
  '.webp',
])
const audioExtensions = new Set(['.flac', '.m4a', '.mp3', '.ogg', '.wav'])
const fontExtensions = new Set(['.otf', '.ttf', '.woff', '.woff2'])
const iconExtensions = new Set(['.svg'])
const knownTextExtensions = new Set([
  '.css',
  '.html',
  '.js',
  '.json',
  '.txt',
  '.webmanifest',
  '.xml',
])

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(2)} MiB`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

function assetCategory(path) {
  const extension = extname(path).toLowerCase()
  if (/^assets\/[^/]+\/bg\//u.test(path)) return 'background-preview'
  if (/^assets\/[^/]+\/originals\//u.test(path)) return 'background-original'
  if (audioExtensions.has(extension)) return 'audio'
  if (fontExtensions.has(extension)) return 'font'
  if (iconExtensions.has(extension)) return 'icon'
  if (imageExtensions.has(extension)) return 'image'
  if (knownTextExtensions.has(extension)) return 'text'
  return 'other-binary'
}

function categoryBudget(category) {
  if (category === 'background-preview') return budgets.backgroundPreview
  if (category === 'background-original') return budgets.backgroundOriginal
  if (category === 'audio') return budgets.audio
  if (category === 'font') return budgets.font
  if (category === 'image' || category === 'icon') return budgets.ordinaryImage
  return null
}

function isVersioned(path) {
  return (
    /^assets\/[^/]*\d{8}[^/]*\//u.test(path) ||
    /-[A-Za-z0-9_-]{8,}\.[^.]+$/u.test(path)
  )
}

function reportMetadata(path, category) {
  const firstScreen =
    category === 'background-preview' ||
    category === 'font' ||
    path === 'res/favicon-320.png'
  const deferrable =
    category === 'background-original' || category === 'audio'
      ? 'yes'
      : category === 'background-preview'
        ? 'conditional'
        : 'no'
  const externalCandidate =
    category === 'background-original' || category === 'audio'
  return { firstScreen, deferrable, externalCandidate }
}

function evaluateBudget(label, actual, budget) {
  if (actual > budget.maximumBytes) {
    failures.push(
      `${label} exceeds budget: ${formatBytes(actual)} > ${formatBytes(budget.maximumBytes)}`,
    )
  } else if (actual >= budget.warningBytes) {
    warnings.push(
      `${label} is near budget: ${formatBytes(actual)} / ${formatBytes(budget.maximumBytes)}`,
    )
  }
}

async function walk(directory) {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await walk(path)))
    else files.push(path)
  }
  return files
}

async function sourceFiles(entry) {
  const path = resolve(root, entry)
  const info = await stat(path)
  if (info.isFile()) return [path]
  return (await walk(path)).filter((file) =>
    textExtensions.has(extname(file).toLowerCase()),
  )
}

const publicFiles = await walk(publicRoot)
const publicByPath = new Map(
  publicFiles.map((file) => [
    relative(publicRoot, file).split(sep).join('/'),
    file,
  ]),
)
const publicByLowerPath = new Map(
  [...publicByPath.keys()].map((path) => [path.toLowerCase(), path]),
)
const references = new Set()
const dynamicReferences = new Set()

function addReference(raw) {
  const value = raw.trim().replaceAll('&amp;', '&')
  if (
    !value ||
    /^(?:data:|blob:|https?:|mailto:|tel:|#)/iu.test(value) ||
    value.includes('/api/') ||
    value.startsWith('api/')
  ) {
    return
  }
  if (value.includes('${')) {
    dynamicReferences.add(value)
    return
  }
  const withoutQuery = value.split(/[?#]/u, 1)[0]
  if (!withoutQuery || withoutQuery === '/') return
  const normalized = decodeURIComponent(withoutQuery.replace(/^\/+/u, ''))
  if (normalized === 'assets/elytrue-20260724') return
  if (
    normalized.startsWith('assets/') ||
    normalized.startsWith('res/') ||
    publicByPath.has(normalized)
  ) {
    references.add(normalized)
  }
}

for (const entry of sourceRoots) {
  for (const file of await sourceFiles(entry)) {
    const source = await readFile(file, 'utf8')
    for (const match of source.matchAll(
      /(?:src|href|content|data-src|data-original)\s*=\s*["']([^"']+)["']/giu,
    )) {
      addReference(match[1])
    }
    for (const match of source.matchAll(
      /url\(\s*["']?([^"')]+)["']?\s*\)/giu,
    )) {
      addReference(match[1])
    }
    for (const match of source.matchAll(
      /["'`](\/?(?:assets|res)\/[^"'`\s)]+)["'`]/giu,
    )) {
      addReference(match[1])
    }
  }
}

for (const entry of deployedSourceRoots) {
  for (const file of await sourceFiles(entry)) {
    const source = await readFile(file, 'utf8')
    for (const marker of forbiddenLegacyMarkers) {
      if (source.toLowerCase().includes(marker)) {
        failures.push(
          `forbidden legacy marker in deployed source: ${relative(root, file).split(sep).join('/')}`,
        )
      }
    }
  }
}

// Expand the intentionally type-driven asset paths assembled in assets.ts.
const assetConfig = await readFile(
  join(root, 'src', 'config', 'assets.ts'),
  'utf8',
)
for (const match of assetConfig.matchAll(
  /background\(\s*'(landscape|portrait)'\s*,\s*(\d+)\s*,\s*'(jpg|png)'/gu,
)) {
  const [, layout, number, extension] = match
  references.add(`assets/elytrue-20260724/bg/${layout}${number}.webp`)
  references.add(
    `assets/elytrue-20260724/originals/${layout}${number}.${extension}`,
  )
}
for (const match of assetConfig.matchAll(/'([^'\r\n]+\.mp3)'/gu)) {
  references.add(`assets/elytrue-20260724/bgm/${match[1]}`)
}

for (const reference of references) {
  if (publicByPath.has(reference)) continue
  const actual = publicByLowerPath.get(reference.toLowerCase())
  failures.push(
    actual
      ? `case mismatch: ${reference} (actual: ${actual})`
      : `missing referenced asset: ${reference}`,
  )
}

const entryAssets = new Set(['index.manifest.json', 'social-share.jpg'])
const orphaned = [...publicByPath.keys()]
  .filter((path) => !references.has(path))
  .filter((path) => !entryAssets.has(path))
  .sort()
if (orphaned.length > 0) {
  failures.push(...orphaned.map((path) => `orphaned public asset: ${path}`))
}

for (const dynamic of dynamicReferences) {
  if (
    dynamic.startsWith('/api/') ||
    dynamic.startsWith('/assets/elytrue-20260724/') ||
    dynamic.startsWith('assets/elytrue-20260724/') ||
    /^\/assets\/\$\{string\}/u.test(dynamic) ||
    /^\$\{(?:msgBgInfo\[|User\.convertAvatarPath|i2\}|background\.(?:preview|creditUrl|original)\}|currentSource\}|nextSource\})/u.test(
      dynamic,
    ) ||
    (dynamic.startsWith('path, new URL(') && dynamic.includes('this.baseUrl'))
  ) {
    notices.push(`recognized dynamic path: ${dynamic}`)
  } else {
    failures.push(`unreviewed dynamic asset path: ${dynamic}`)
  }
}

const hashes = new Map()
const musicHashes = new Map()
const assetRecords = []
for (const [path, file] of publicByPath) {
  const info = await stat(file)
  const category = assetCategory(path)
  assetRecords.push({ path, size: info.size, category })
  if (info.size > budgets.edgeOneFileMaximumBytes) {
    failures.push(
      `asset exceeds EdgeOne 25 MiB limit: ${path} (${(info.size / 1024 / 1024).toFixed(2)} MiB)`,
    )
  }
  const budget = categoryBudget(category)
  if (budget) evaluateBudget(path, info.size, budget)
  if (category === 'other-binary') {
    warnings.push(`unknown binary asset: ${path} (${formatBytes(info.size)})`)
  }
  if (info.size >= budgets.unversionedLargeWarningBytes && !isVersioned(path)) {
    warnings.push(
      `large unversioned asset: ${path} (${formatBytes(info.size)})`,
    )
  }
  const hash = createHash('sha256')
    .update(await readFile(file))
    .digest('hex')
  const group = hashes.get(hash) ?? []
  group.push(path)
  hashes.set(hash, group)
  if (path.toLowerCase().endsWith('.mp3')) {
    const existing = musicHashes.get(hash)
    if (existing)
      failures.push(`duplicate music content: ${existing} and ${path}`)
    else musicHashes.set(hash, path)
  }
}

const publicAssetsBytes = assetRecords
  .filter((record) => record.path.startsWith('assets/'))
  .reduce((total, record) => total + record.size, 0)
const publicResBytes = assetRecords
  .filter((record) => record.path.startsWith('res/'))
  .reduce((total, record) => total + record.size, 0)
evaluateBudget(
  'public/assets total',
  publicAssetsBytes,
  budgets.publicAssetsTotal,
)
evaluateBudget('public/res total', publicResBytes, budgets.publicResTotal)
evaluateBudget(
  'public total',
  assetRecords.reduce((total, record) => total + record.size, 0),
  budgets.publicTotal,
)

for (const paths of hashes.values()) {
  if (paths.length > 1)
    notices.push(`duplicate file content: ${paths.join(', ')}`)
}

if (notices.length > 0) {
  console.log('Asset audit notes:')
  for (const notice of notices) console.log(`- ${notice}`)
}

if (warnings.length > 0) {
  console.warn('Asset audit warnings:')
  for (const warning of warnings) console.warn(`- ${warning}`)
}

if (reportRequested) {
  console.log('Asset governance report:')
  console.log(
    'Path | Type | Size | Category | Versioned/hash | First screen | Deferrable | External candidate',
  )
  for (const record of assetRecords
    .filter(({ path }) => path.startsWith('assets/') || path.startsWith('res/'))
    .sort((left, right) => left.path.localeCompare(right.path))) {
    const metadata = reportMetadata(record.path, record.category)
    console.log(
      [
        `public/${record.path}`,
        extname(record.path).slice(1).toLowerCase() || 'none',
        formatBytes(record.size),
        record.category,
        isVersioned(record.path) ? 'yes' : 'no',
        metadata.firstScreen ? 'yes' : 'no',
        metadata.deferrable,
        metadata.externalCandidate ? 'yes' : 'no',
      ].join(' | '),
    )
  }
}

if (failures.length > 0) {
  console.error('Asset audit failed:')
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  const assetBytes = (
    await Promise.all(publicFiles.map((file) => stat(file)))
  ).reduce((total, info) => total + info.size, 0)
  console.log(
    `Asset audit passed: ${publicFiles.length} files, ${(assetBytes / 1024 / 1024).toFixed(2)} MiB, ${references.size} static references, ${warnings.length} warning(s).`,
  )
}
