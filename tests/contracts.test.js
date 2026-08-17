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

describe('Blob key contract', () => {
  test('defines the comment read-model key shapes', () => {
    assert.equal(blobKeys.user('u-1'), 'users/u-1.json')
    assert.equal(blobKeys.userNameIndex('abc'), 'indexes/users/name/abc.json')
    assert.equal(blobKeys.userEmailIndex('def'), 'indexes/users/email/def.json')
    assert.equal(blobKeys.userUid(42), 'indexes/users/uid/42.json')
    assert.equal(blobKeys.userUidHint, 'meta/users-uid-hint.json')
    assert.equal(blobKeys.userUidSchema, 'meta/users-uid-schema.json')
    assert.equal(blobKeys.session('token'), 'sessions/token.json')
    assert.equal(
      blobKeys.recoveryKeyClaim('u-1', 2),
      'recovery-key-claims/u-1/2.json',
    )
    assert.equal(blobKeys.comment(123), 'comments/0000000000000123.json')
    assert.equal(blobKeys.commentNumber(7), 'indexes/comments/number/7.json')
    assert.equal(
      blobKeys.commentByUser('u-1', 123),
      'indexes/comments/by-user/u-1/9007199254740868-0000000000000123.json',
    )
    assert.equal(
      blobKeys.commentPublicView(123),
      'views/comments/public/9007199254740868-0000000000000123.json',
    )
    assert.equal(blobKeys.commentsLatestView, 'views/comments/latest.json')
    assert.equal(
      blobKeys.commentsLatestRevision,
      'views/comments/revision.json',
    )
    assert.equal(
      blobKeys.commentsPreviousLatestView,
      'views/comments/latest-previous.json',
    )
    assert.equal(
      blobKeys.commentsDailyCount('2026-08-02'),
      'views/comments/daily-count/2026-08-02.json',
    )
    assert.equal(
      blobKeys.commentByDate('2026-08-02', 123),
      'dates/2026-08-02/0000000000000123.json',
    )
    assert.equal(blobKeys.commentLike(123, 'u-1'), 'likes/123/u-1.json')
    assert.equal(blobKeys.commentReport(123, 'u-1'), 'reports/123/u-1.json')
    assert.equal(blobKeys.commentViewRepair(123), 'repairs/comment-views/123.json')
    assert.equal(blobKeys.commentOperation('op-1'), 'operations/comments/op-1.json')
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
      assert.ok(
        typeof route.csrf === 'boolean' || route.csrf === 'authenticated',
      )
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
