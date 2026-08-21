import { readdir, readFile } from 'node:fs/promises'
import { extname, join, relative, sep } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('../', import.meta.url))
const SOURCE_EXTENSIONS = new Set([
  '.js',
  '.mjs',
  '.cjs',
  '.ts',
  '.tsx',
  '.vue',
])
const violations = []

const RULES = [
  {
    roots: ['server', 'cloud-functions', 'edge-functions'],
    checks: [
      [
        /(?:from\s+|import\s*\()\s*['"][^'"]*(?:\/src\/|\\src\\)/,
        'production server code must not import frontend source',
      ],
      [
        /(?:from\s+|import\s*\()\s*['"](?:vue|vite|@vitejs\/|@playwright\/|playwright)/,
        'production server code must not import frontend/build/test packages',
      ],
      [
        /\b(?:window|document|navigator|localStorage|sessionStorage|indexedDB)\s*[.[(]/,
        'production server code must not read browser globals',
      ],
      [
        /(?:from\s+|import\s*\()\s*['"]node:sqlite['"]/,
        'node:sqlite is not part of the supported Node 20 Cloud Functions baseline',
      ],
      [
        /\bprocess\.getBuiltinModule\b|\bimport\.meta\.(?:dirname|filename)\b|\b(?:fs|fsPromises)\.(?:glob|globSync)\b|import\s*\{[^}]*\bglob(?:Sync)?\b[^}]*\}\s*from\s*['"]node:fs(?:\/promises)?['"]/,
        'production server code uses an API outside the Node 20 compatibility baseline',
      ],
    ],
  },
  {
    roots: ['src'],
    checks: [
      [
        /(?:from\s+|import\s*\()\s*['"][^'"]*(?:server|cloud-functions)(?:\/|\\)/,
        'frontend code must not import server or Cloud Functions internals',
      ],
    ],
  },
  {
    roots: ['edge-functions'],
    checks: [
      [
        /(?:from\s+|import\s*\()\s*['"](?:node:|fs(?:\/promises)?|path|crypto|buffer|process)(?:['"/])/,
        'Edge Functions must not import Node-only APIs',
      ],
      [
        /\b(?:Buffer|process|require|__dirname|__filename)\b/,
        'Edge Functions must not use Node globals',
      ],
    ],
  },
  {
    roots: ['shared'],
    checks: [
      [
        /(?:from\s+|import\s*\()\s*['"](?:node:|fs(?:\/promises)?|path|crypto|buffer|process|os|stream)/,
        'shared modules must not import Node-only APIs',
      ],
      [
        /\b(?:window|document|navigator|localStorage|sessionStorage|indexedDB)\s*[.[(]/,
        'shared modules must not depend on DOM/browser globals',
      ],
    ],
  },
]

const MIDDLEWARE_CHECKS = [
  [
    /(?:from\s+|import\s*\()\s*['"]node:/,
    'middleware must not import node:* modules',
  ],
  [
    /(?:from\s+|import\s*\()\s*['"](?:fs(?:\/promises)?|path|crypto|buffer|process)(?:['"/])/,
    'middleware must not import Node built-ins',
  ],
  [
    /\b(?:Buffer|process|require|__dirname|__filename)\b/,
    'middleware must not use Node globals',
  ],
  [/\bprocess\.env\b/, 'middleware configuration must come from context.env'],
  [
    /\bglobalThis\.ELYTRUE_/,
    'middleware bindings must come from context.env, not injected globals',
  ],
]

async function collectFiles(directory) {
  const files = []
  const entries = await readdir(directory, { withFileTypes: true }).catch(
    (error) => {
      if (error?.code === 'ENOENT') return []
      throw error
    },
  )
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await collectFiles(path)))
    else if (SOURCE_EXTENSIONS.has(extname(entry.name))) files.push(path)
  }
  return files
}

function report(file, message) {
  violations.push(`${relative(ROOT, file).split(sep).join('/')}: ${message}`)
}

for (const rule of RULES) {
  for (const root of rule.roots) {
    const directory = join(ROOT, root)
    for (const file of await collectFiles(directory)) {
      const source = await readFile(file, 'utf8')
      for (const [pattern, message] of rule.checks) {
        if (pattern.test(source)) report(file, message)
      }
    }
  }
}

const middlewarePath = join(ROOT, 'middleware.js')
const middlewareSource = await readFile(middlewarePath, 'utf8')
for (const [pattern, message] of MIDDLEWARE_CHECKS) {
  if (pattern.test(middlewareSource)) report(middlewarePath, message)
}

if (violations.length > 0) {
  console.error('Runtime boundary violations:')
  for (const violation of violations) console.error(`- ${violation}`)
  process.exitCode = 1
} else {
  console.log('Runtime boundaries are clean.')
}
