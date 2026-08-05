import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { describe, test } from 'node:test'
import { blobKeys } from '../server/domain/blob-keys.js'
import { API_ROUTE_HANDLERS } from '../server/app.js'
import {
  API_ROUTES,
  matchApiRoute,
  validateApiRouteRegistry,
} from '../server/routes/registry.js'

describe('historical Blob key contract', () => {
  test('preserves every production key shape', () => {
    assert.equal(blobKeys.user('u-1'), 'users/u-1.json')
    assert.equal(blobKeys.userNameIndex('abc'), 'indexes/users/name/abc.json')
    assert.equal(blobKeys.userEmailIndex('def'), 'indexes/users/email/def.json')
    assert.equal(blobKeys.session('token'), 'sessions/token.json')
    assert.equal(
      blobKeys.recoveryKeyClaim('u-1', 2),
      'recovery-key-claims/u-1/2.json',
    )
    assert.equal(blobKeys.comment(123), 'comments/0000000000000123.json')
    assert.equal(blobKeys.commentNumber(7), 'indexes/comments/number/7.json')
    assert.equal(
      blobKeys.commentNumberReverse(123),
      'indexes/comments/by-id/0000000000000123.json',
    )
    assert.equal(
      blobKeys.commentByUser('u-1', 123),
      'indexes/comments/by-user/u-1/0000000000000123.json',
    )
    assert.equal(
      blobKeys.commentByDate('2026-08-02', 123),
      'dates/2026-08-02/0000000000000123.json',
    )
    assert.equal(blobKeys.commentLike(123, 'u-1'), 'likes/123/u-1.json')
    assert.equal(blobKeys.commentReport(123, 'u-1'), 'reports/123/u-1.json')
    assert.equal(
      blobKeys.commentDeleteRepair(123),
      'repairs/comment-delete/123.json',
    )
    assert.equal(
      blobKeys.imageAlias('comment', 'image-1'),
      'uploads/aliases/comments/image-1.json',
    )
    assert.equal(
      blobKeys.imageAlias('avatar', 'image-1'),
      'uploads/aliases/avatars/image-1.json',
    )
    assert.equal(
      blobKeys.uploadBlob('comment', 'u-1', 'image-1', 'jpg'),
      'comments/u-1/image-1.jpg',
    )
    assert.equal(blobKeys.uploadUsage, 'usage/uploads.json')
    assert.equal(blobKeys.imageUploadOperation('image-1'), 'operations/image-uploads/image-1.json')
    assert.equal(blobKeys.imageDeleteOperation('image-1'), 'operations/image-deletes/image-1.json')
    assert.equal(blobKeys.avatarUpdateOperation('operation-1'), 'operations/avatar-updates/operation-1.json')
    assert.equal(blobKeys.avatarDeleteOperation('image-1'), 'operations/avatar-deletes/image-1.json')
    assert.equal(blobKeys.avatarUpdateRepair('operation-1'), 'repairs/avatar-update/operation-1.json')
  })
})

describe('declarative API route contract', () => {
  test('keeps route method/path combinations unique and resolvable', () => {
    const signatures = []
    for (const route of API_ROUTES) {
      for (const method of route.methods) {
        const signature = `${method} ${route.match.kind}:${route.match.path}`
        assert.equal(signatures.includes(signature), false, signature)
        signatures.push(signature)
        assert.equal(matchApiRoute(method, route.match.path), route)
      }
      assert.ok(['public', 'optional', 'session', 'admin'].includes(route.auth))
      assert.equal(typeof route.csrf, 'boolean')
    }
    assert.equal(matchApiRoute('PATCH', 'comments'), undefined)
    assert.equal(matchApiRoute('GET', 'missing'), undefined)
  })

  test('requires complete policies and registered handlers', () => {
    assert.equal(validateApiRouteRegistry(API_ROUTES, Object.keys(API_ROUTE_HANDLERS)), true)
    assert.equal(Object.isFrozen(API_ROUTE_HANDLERS), true)
    assert.equal(
      Object.keys(API_ROUTE_HANDLERS).sort().join(','),
      [...new Set(API_ROUTES.map((route) => route.handler))].sort().join(','),
    )
    assert.equal(
      Object.values(API_ROUTE_HANDLERS).every((handler) => typeof handler === 'function'),
      true,
    )
    assert.throws(
      () => validateApiRouteRegistry([
        { methods: ['GET'], match: { kind: 'exact', path: 'test' }, handler: 'missing', auth: 'public' },
      ], Object.keys(API_ROUTE_HANDLERS)),
      /Missing API route CSRF policy/u,
    )
  })

  test('keeps the EdgeOne Cloud Function entry path and export unchanged', async () => {
    const entry = await readFile(
      new URL('../cloud-functions/api/[[default]].js', import.meta.url),
      'utf8',
    )
    assert.match(entry, /import \{ handleApiRequest \} from '\.\.\/\.\.\/server\/app\.js'/u)
    assert.match(entry, /export default function onRequest\(context\)/u)
  })

})

