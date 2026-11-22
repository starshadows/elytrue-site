import assert from 'node:assert/strict'
import test from 'node:test'
import { isStaticAssetRequest, middleware } from '../middleware.js'

function createContext(url, options = {}) {
  const request = new Request(url, {
    method: options.method || 'GET',
    headers: options.headers,
  })
  return {
    request,
    next:
      options.next ||
      (() =>
        new Response('ok', {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        })),
    redirect: (location, status) => Response.redirect(location, status),
  }
}

test('middleware redirects www and blog subdomains to canonical https origin', async () => {
  for (const host of ['www.elytrue.com', 'blog.elytrue.com']) {
    const response = await middleware(
      createContext(`http://${host}/?ref=test`),
    )
    assert.equal(response.status, 301)
    assert.equal(
      response.headers.get('location'),
      'https://elytrue.com/?ref=test',
    )
    assert.equal(
      response.headers.get('strict-transport-security'),
      'max-age=31536000; includeSubDomains',
    )
  }
})

test('middleware bypasses static GET/HEAD assets without mutating response', async () => {
  for (const path of [
    '/assets/elytrue-shell-20260805/favicon-320-c998712d.png',
    '/res/download.svg',
    '/index.manifest.json',
    '/social-share.jpg',
  ]) {
    const request = new Request(`https://elytrue.com${path}`, { method: 'GET' })
    assert.equal(isStaticAssetRequest(request, path), true)
  }

  let nextCalled = false
  const original = new Response('asset-bytes', {
    headers: { 'content-type': 'image/svg+xml' },
  })
  const response = await middleware(
    createContext('https://elytrue.com/res/download.svg', {
      next: () => {
        nextCalled = true
        return original
      },
    }),
  )
  assert.equal(nextCalled, true)
  assert.equal(response, original)
})

test('middleware applies document-only CSP to HTML and transport headers to non-HTML', async () => {
  const html = await middleware(
    createContext('https://elytrue.com/', {
      next: () =>
        new Response('<!doctype html>', {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        }),
    }),
  )
  assert.match(html.headers.get('content-security-policy'), /script-src 'self'/u)
  assert.doesNotMatch(
    html.headers.get('content-security-policy'),
    /script-src[^;]*unsafe-inline/u,
  )
  assert.equal(html.headers.get('x-frame-options'), 'DENY')
  assert.equal(
    html.headers.get('strict-transport-security'),
    'max-age=31536000; includeSubDomains',
  )

  const api = await middleware(
    createContext('https://elytrue.com/api/health', {
      next: () =>
        new Response('{"code":1}', {
          headers: { 'content-type': 'application/json; charset=utf-8' },
        }),
    }),
  )
  assert.equal(api.headers.get('content-security-policy'), null)
  assert.equal(api.headers.get('x-content-type-options'), 'nosniff')
  assert.equal(
    api.headers.get('strict-transport-security'),
    'max-age=31536000; includeSubDomains',
  )
})
