import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
const publicRoot = join(root, 'public')
const maximumBytes = 25 * 1024 * 1024
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
const failures = []
const notices = []

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
    if (file.includes(`${sep}public${sep}yumeniwa${sep}`)) continue
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

const protectedDirectRoutes = new Set([
  'yumeniwa/README.md',
  'yumeniwa/index.html',
  'yumeniwa/link.png',
])
const entryAssets = new Set(['index.manifest.json', 'social-share.jpg'])
const orphaned = [...publicByPath.keys()]
  .filter((path) => !references.has(path))
  .filter((path) => !protectedDirectRoutes.has(path))
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
for (const [path, file] of publicByPath) {
  const info = await stat(file)
  if (info.size > maximumBytes) {
    failures.push(
      `asset exceeds EdgeOne 25 MiB limit: ${path} (${(info.size / 1024 / 1024).toFixed(2)} MiB)`,
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

for (const paths of hashes.values()) {
  if (paths.length > 1)
    notices.push(`duplicate file content: ${paths.join(', ')}`)
}

if (notices.length > 0) {
  console.log('Asset audit notes:')
  for (const notice of notices) console.log(`- ${notice}`)
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
    `Asset audit passed: ${publicFiles.length} files, ${(assetBytes / 1024 / 1024).toFixed(2)} MiB, ${references.size} static references.`,
  )
}
