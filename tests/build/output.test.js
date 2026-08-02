import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { describe, test } from 'node:test'

const dist = new URL('../../dist/', import.meta.url)

describe('EdgeOne build output', () => {
  test('contains a small SPA shell and hashed first-party assets', async () => {
    const html = await readFile(new URL('index.html', dist), 'utf8')
    const legacyHtml = await readFile(
      new URL('yumeniwa/index.html', dist),
      'utf8',
    )
    const assets = await readdir(new URL('assets/', dist))
    assert.match(html, /<div id="app"><\/div>/u)
    assert.doesNotMatch(html, /\son(?:click|change|focus|blur|load)=/iu)
    assert.doesNotMatch(html, /javascript:/iu)
    assert.doesNotMatch(legacyHtml, /\son(?:click|change|focus|blur|load)=/iu)
    assert.doesNotMatch(
      legacyHtml,
      /<script(?![^>]*\bsrc=)[^>]*>/iu,
      'retained direct routes must not require inline scripts',
    )
    assert.ok(assets.some((name) => /^index-[A-Za-z0-9_-]+\.js$/u.test(name)))
    assert.ok(assets.some((name) => /^index-[A-Za-z0-9_-]+\.css$/u.test(name)))
    assert.ok((await stat(new URL('index.html', dist))).size < 10 * 1024)
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
      /\son(?:click|change|focus|blur)=["']/iu,
      'compiled application must not create CSP-blocked inline event attributes',
    )
  })

  test('ships strict script CSP and path-specific cache policies', async () => {
    const config = JSON.parse(
      await readFile(new URL('../../edgeone.json', import.meta.url), 'utf8'),
    )
    const headersFor = (source) =>
      Object.fromEntries(
        config.headers
          .find((rule) => rule.source === source)
          .headers.map((header) => [header.key, header.value]),
      )
    const global = headersFor('/*')
    assert.match(global['Content-Security-Policy'], /script-src 'self'/u)
    assert.doesNotMatch(global['Content-Security-Policy'], /unsafe-eval/u)
    assert.doesNotMatch(
      global['Content-Security-Policy'],
      /script-src[^;]*unsafe-inline/u,
    )
    assert.equal(global['Cache-Control'], 'no-cache')
    assert.equal(
      headersFor('/assets/*')['Cache-Control'],
      'public, max-age=31536000, immutable',
    )
    assert.equal(
      headersFor('/res/*')['Cache-Control'],
      'public, max-age=300, must-revalidate',
    )
    assert.equal(headersFor('/api/*')['Cache-Control'], 'no-store')
  })
})
