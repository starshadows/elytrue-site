import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { describe, test } from 'node:test'
import {
  CRITICAL_STARTUP_SCRIPT_HASH,
  DOCUMENT_SECURITY_HEADERS,
} from '../../shared/security-headers.js'

const dist = new URL('../../dist/', import.meta.url)
const forbiddenLegacyMarkers = [
  ['yume', 'niwa'].join(''),
  ['haojiezhe12345', '.top'].join(''),
  ['madohomu', '.love'].join(''),
  ['yume', 'niwa.', 'madohomu', '.love'].join(''),
]

async function collectFiles(directory, prefix = '') {
  const files = []
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name
    if (entry.isDirectory()) {
      files.push(
        ...(await collectFiles(
          new URL(`${entry.name}/`, directory),
          relativePath,
        )),
      )
    } else {
      files.push({
        path: relativePath,
        url: new URL(entry.name, directory),
      })
    }
  }
  return files
}

describe('EdgeOne build output', () => {
  test('pins Node 20 types and verifies server code in a Node 20 CI job', async () => {
    const packageJson = JSON.parse(
      await readFile(new URL('../../package.json', import.meta.url), 'utf8'),
    )
    const packageLock = JSON.parse(
      await readFile(
        new URL('../../package-lock.json', import.meta.url),
        'utf8',
      ),
    )
    const serverConfig = JSON.parse(
      await readFile(
        new URL('../../tsconfig.server.json', import.meta.url),
        'utf8',
      ),
    )
    const workflow = await readFile(
      new URL('../../.github/workflows/ci.yml', import.meta.url),
      'utf8',
    )
    const viteConfig = await readFile(
      new URL('../../vite.config.ts', import.meta.url),
      'utf8',
    )

    assert.match(packageJson.devDependencies['@types/node'], /^20\./u)
    assert.equal(packageJson.dependencies['@edgeone/pages-blob'], '0.0.15')
    assert.equal(
      packageLock.packages[''].dependencies['@edgeone/pages-blob'],
      '0.0.15',
    )
    assert.equal(
      packageLock.packages['node_modules/@edgeone/pages-blob'].version,
      '0.0.15',
    )
    assert.equal(packageJson.scripts['build:deploy'], 'npm run build:edgeone')
    assert.match(
      packageJson.scripts.build,
      /vite build && node scripts\/stage-public-assets\.mjs/u,
    )
    assert.match(viteConfig, /publicDir:\s*false/u)
    assert.match(
      packageLock.packages['node_modules/@types/node'].version,
      /^20\./u,
    )
    assert.equal(serverConfig.compilerOptions.target, 'ES2022')
    assert.deepEqual(serverConfig.compilerOptions.types, ['node'])
    assert.equal(serverConfig.compilerOptions.noUncheckedIndexedAccess, true)
    assert.match(workflow, /server-node20:[\s\S]*?node-version: 20\.x/u)
    assert.match(
      workflow,
      /server-node20:[\s\S]*?npm ci[\s\S]*?npm run check:server[\s\S]*?npm run test:server/u,
    )
    assert.doesNotMatch(workflow, /runs-on: (?:ubuntu|windows)-latest/u)
    assert.match(
      workflow,
      /verify:\n\s+runs-on: ubuntu-24\.04\n\s+timeout-minutes: 10/u,
    )
    assert.match(
      workflow,
      /e2e:\n(?:.|\n)*?runs-on: windows-2022\n\s+timeout-minutes: 15/u,
    )
    assert.match(
      workflow,
      /server-node20:\n\s+runs-on: ubuntu-24\.04\n\s+timeout-minutes: 10/u,
    )
    assert.ok(
      [...workflow.matchAll(/uses:\s+[^\s]+@([^\s#]+)/gu)].every(([, sha]) =>
        /^[0-9a-f]{40}$/u.test(sha),
      ),
    )
    assert.doesNotMatch(workflow, /continue-on-error:/u)
    assert.match(workflow, /npm run audit:dev:critical/u)
    assert.match(workflow, /npm run install:playwright/u)
    assert.match(workflow, /Print build budget report/u)
    assert.match(workflow, /actions\/upload-artifact@[0-9a-f]{40}/u)
  })

  test('contains a small SPA shell and hashed first-party assets', async () => {
    const html = await readFile(new URL('index.html', dist), 'utf8')
    const assets = await readdir(new URL('assets/', dist))
    assert.match(html, /<div id="app"><\/div>/u)
    assert.doesNotMatch(html, /\son(?:click|change|focus|blur|load)=/iu)
    assert.doesNotMatch(html, /javascript:/iu)
    assert.ok(assets.some((name) => /^index-[A-Za-z0-9_-]+\.js$/u.test(name)))
    assert.ok(assets.some((name) => /^index-[A-Za-z0-9_-]+\.css$/u.test(name)))
    const imagePreloads = [
      ...html.matchAll(/<link\b[^>]*rel="preload"[^>]*>/gu),
    ]
      .map(([tag]) => tag)
      .filter((tag) => /\bas="image"/u.test(tag))
    assert.equal(imagePreloads.length, 0)
    assert.match(html, /dataset\.elyInitialBackground=h\.id/u)
    assert.match(html, /fetchPriority='high'/u)
    const startupScript = [...html.matchAll(/<script>([\s\S]*?)<\/script>/gu)]
      .map((match) => match[1])
      .find((script) => script.includes('__ELY_VISIT_ASSETS__'))
    assert.ok(startupScript)
    assert.doesNotMatch(startupScript, /comments|\/api\//iu)
    assert.equal(
      `sha256-${createHash('sha256').update(startupScript).digest('base64')}`,
      CRITICAL_STARTUP_SCRIPT_HASH,
    )
    assert.ok(
      DOCUMENT_SECURITY_HEADERS['Content-Security-Policy'].includes(
        `'${CRITICAL_STARTUP_SCRIPT_HASH}'`,
      ),
    )
    assert.equal(
      new Set(
        [...html.matchAll(/"preview":"(\/assets\/[^"]+\.webp)"/gu)].map(
          (match) => match[1],
        ),
      ).size,
      28,
    )
    assert.ok((await stat(new URL('index.html', dist))).size < 10 * 1024)
  })

  test('does not ship the removed legacy proxy or its external origins', async () => {
    const files = await collectFiles(dist)
    for (const file of files) {
      const content = (await readFile(file.url, 'utf8')).toLowerCase()
      for (const marker of forbiddenLegacyMarkers) {
        assert.equal(
          file.path.toLowerCase().includes(marker),
          false,
          `legacy marker appears in output path: ${file.path}`,
        )
        assert.equal(
          content.includes(marker),
          false,
          `legacy marker appears in output file: ${file.path}`,
        )
      }
    }
  })

  test('does not bundle server, test, CLI, or Node-only modules', async () => {
    const assetNames = await readdir(new URL('assets/', dist))
    const javascript = (
      await Promise.all(
        assetNames
          .filter((name) => name.endsWith('.js'))
          .map((name) => readFile(new URL(`assets/${name}`, dist), 'utf8')),
      )
    ).join('\n')
    assert.doesNotMatch(
      javascript,
      /@edgeone\/pages-blob|edgeone makers|playwright|node:fs|node:crypto|server\/app/u,
    )
    assert.doesNotMatch(
      javascript,
      /\/api\/(?:user|comments|uploads|admin)|loginPopup|userHome/u,
    )
    assert.doesNotMatch(
      javascript,
      /\son(?:click|change|focus|blur)=["']/iu,
      'compiled application must not create CSP-blocked inline event attributes',
    )
  })

  test('does not publish tests, maintenance files, secrets, or source maps', async () => {
    const files = await collectFiles(dist)
    const forbiddenPath =
      /(?:^|\/)(?:tests?|scripts?)(?:\/|$)|(?:^|\/)\.env(?:\.[^/]*)?$|(?:^|\/)credentials?(?:\.[^/]*)?$|\.(?:map|pem|key)$/iu
    const textExtensions = new Set([
      '.css',
      '.html',
      '.js',
      '.json',
      '.txt',
      '.xml',
    ])
    for (const file of files) {
      assert.doesNotMatch(file.path, forbiddenPath)
      const extension = file.path
        .slice(file.path.lastIndexOf('.'))
        .toLowerCase()
      if (!textExtensions.has(extension)) continue
      const content = await readFile(file.url, 'utf8')
      assert.doesNotMatch(
        content,
        /BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY|ELYTRUE_APP_SECRET\s*=|RESEND_API_KEY\s*=/u,
      )
      assert.doesNotMatch(content, /sourceMappingURL=/u)
    }
  })

  test('keeps the API function entry separate from the SPA fallback', async () => {
    const config = JSON.parse(
      await readFile(new URL('../../edgeone.json', import.meta.url), 'utf8'),
    )
    const apiEntry = await readFile(
      new URL('../../cloud-functions/api/[[default]].js', import.meta.url),
      'utf8',
    )
    assert.deepEqual(config.rewrites, [
      { source: '/*', destination: '/index.html' },
    ])
    assert.equal(config.buildCommand, 'npm run build:edgeone')
    assert.deepEqual(config.cloudFunctions, {
      regions: { mainland: ['ap-shanghai'] },
      maxDuration: 30,
    })
    assert.match(apiEntry, /handleApiRequest/u)
    assert.match(apiEntry, /export default/u)
  })

  test('ships transport security and path-specific cache policies', async () => {
    const config = JSON.parse(
      await readFile(new URL('../../edgeone.json', import.meta.url), 'utf8'),
    )
    const cacheRules = config.headers.filter((rule) =>
      rule.headers.some((header) => header.key === 'Cache-Control'),
    )
    const matchingCacheRules = (pathname) =>
      cacheRules.filter((rule) => {
        if (rule.source.endsWith('/*')) {
          return pathname.startsWith(rule.source.slice(0, -1))
        }
        return pathname === rule.source
      })
    const headersFor = (source) =>
      Object.fromEntries(
        config.headers
          .find((rule) => rule.source === source)
          .headers.map((header) => [header.key, header.value]),
      )
    const global = headersFor('/*')
    assert.equal(global['Content-Security-Policy'], undefined)
    assert.equal(
      global['Strict-Transport-Security'],
      'max-age=31536000; includeSubDomains',
    )
    assert.doesNotMatch(global['Strict-Transport-Security'], /\bpreload\b/iu)
    assert.equal(global['Cache-Control'], undefined)
    assert.equal(headersFor('/')['Cache-Control'], 'no-cache')
    assert.equal(headersFor('/index.html')['Cache-Control'], 'no-cache')
    assert.equal(
      headersFor('/index.manifest.json')['Cache-Control'],
      'no-cache',
    )
    assert.equal(
      headersFor('/assets/*')['Cache-Control'],
      'public, max-age=31536000, immutable',
    )
    assert.equal(
      headersFor('/res/*')['Cache-Control'],
      'public, max-age=300, must-revalidate',
    )
    assert.equal(
      config.headers.some((rule) => rule.source.startsWith('/api/comments')),
      false,
    )
    assert.equal(
      matchingCacheRules(
        '/assets/elytrue-shell-20260805/favicon-320-c998712d.png',
      ).length,
      1,
    )
    assert.equal(
      matchingCacheRules(
        '/assets/elytrue-shell-20260805/favicon-320-c998712d.png',
      )[0].headers[0].value,
      'public, max-age=31536000, immutable',
    )
    assert.equal(matchingCacheRules('/res/reply.svg').length, 1)
    assert.equal(
      matchingCacheRules('/res/reply.svg')[0].headers[0].value,
      'public, max-age=300, must-revalidate',
    )
    assert.equal(
      matchingCacheRules('/api/data/images/avatars/id.png').length,
      0,
    )
    assert.equal(matchingCacheRules('/api/data/images/posts/id.png').length, 0)
    assert.equal(matchingCacheRules('/api/health').length, 0)
    for (const pathname of [
      '/',
      '/index.html',
      '/index.manifest.json',
      '/res/reply.svg',
      '/assets/elytrue-shell-20260805/default-avatar-320-dd2f4539.png',
    ]) {
      assert.equal(matchingCacheRules(pathname).length, 1, pathname)
    }
  })

  test('does not ship legacy unversioned shell resources', async () => {
    const files = await collectFiles(dist)
    const contents = await Promise.all(
      files
        .filter((file) => /\.(?:html|js|json|css)$/iu.test(file.path))
        .map((file) => readFile(file.url, 'utf8')),
    )
    const output = contents.join('\n')
    assert.doesNotMatch(output, /(?:favicon-320|defaultAvatar)\.png/iu)
    assert.ok(
      files.some(
        (file) =>
          file.path ===
          'assets/elytrue-shell-20260805/favicon-320-c998712d.png',
      ),
    )
    assert.ok(
      files.some(
        (file) =>
          file.path ===
          'assets/elytrue-shell-20260805/default-avatar-320-dd2f4539.png',
      ),
    )
  })
})
