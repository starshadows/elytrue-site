import assert from 'node:assert/strict'
import { readdir, readFile, stat } from 'node:fs/promises'
import { describe, test } from 'node:test'

const dist = new URL('../../dist/', import.meta.url)

describe('EdgeOne build output', () => {
  test('contains a small SPA shell and hashed first-party assets', async () => {
    const html = await readFile(new URL('index.html', dist), 'utf8')
    const assets = await readdir(new URL('assets/', dist))
    assert.match(html, /<div id="app"><\/div>/u)
    assert.doesNotMatch(html, /\son(?:click|change|load)=/iu)
    assert.doesNotMatch(html, /javascript:/iu)
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
  })
})
