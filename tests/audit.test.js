import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { auditCommentLikes } from '../scripts/audit-comment-likes.mjs'
import { auditUploadStorage } from '../scripts/audit-upload-storage.mjs'
import { MemoryStore } from '../server/storage.js'

describe('comment like audit', () => {
    it('reports and repairs cache differences without touching comment facts', async () => {
        const data = new MemoryStore()
        const commentId = 1234567890123456
        await data.setJSON(`comments/${String(commentId).padStart(16, '0')}.json`, {
            id: commentId,
            likeCount: 0,
            likeCountVersion: 1,
        })
        await data.setJSON(`likes/${commentId}/user-a.json`, { userId: 'user-a' })
        await data.setJSON(`likes/${commentId}/user-b.json`, { userId: 'user-b' })
        await data.setJSON(`cache/comment-like-count/${commentId}.json`, {
            commentId,
            count: 1,
        })
        await data.setJSON(`repairs/comment-like-count/${commentId}.json`, {
            commentId,
            status: 'open',
        })

        const report = await auditCommentLikes(data)
        assert.equal(report.differences.length, 1)
        assert.deepEqual(report.differences[0], {
            key: `comments/${String(commentId).padStart(16, '0')}.json`,
            comment: {
                id: commentId,
                likeCount: 0,
                likeCountVersion: 1,
            },
            cached: 1,
            actual: 2,
        })

        const fixed = await auditCommentLikes(data, { fix: true })
        assert.equal(fixed.repaired, 1)
        assert.equal(
            (await data.get(`cache/comment-like-count/${commentId}.json`, { type: 'json' })).count,
            2,
        )
        assert.equal(await data.get(`repairs/comment-like-count/${commentId}.json`, { type: 'json' }), null)
        assert.ok(await data.get(`likes/${commentId}/user-a.json`, { type: 'json' }))
    })
})

describe('upload storage audit', () => {
    it('reports inventory, usage and unfinished operations', async () => {
        const data = new MemoryStore()
        const uploads = new MemoryStore()
        await data.setJSON('uploads/aliases/comments/attached.json', {
            imageId: 'attached',
            userId: 'user-a',
            blobKey: 'comments/user-a/attached.jpg',
            size: 8,
        })
        await data.setJSON('uploads/aliases/comments/dangling.json', {
            imageId: 'dangling',
            userId: 'user-a',
            blobKey: 'comments/user-a/missing.jpg',
            size: 4,
        })
        await uploads.set('comments/user-a/attached.jpg', new Uint8Array(8))
        await uploads.set('comments/user-a/orphan.jpg', new Uint8Array(3))
        await data.setJSON('usage/uploads.json', { uploadedBytes: 10 })
        await data.setJSON('operations/image-uploads/open.json', {
            operationId: 'open',
            imageId: 'open',
            phase: 'usage-repair-needed',
        })

        const report = await auditUploadStorage(data, uploads)
        assert.equal(report.aliases, 2)
        assert.equal(report.physicalBlobs, 2)
        assert.equal(report.aliasBytes, 12)
        assert.equal(report.usageBytes, 10)
        assert.equal(report.usageDelta, -2)
        assert.deepEqual(report.danglingAliases, ['dangling'])
        assert.deepEqual(report.orphanBlobs, ['comments/user-a/orphan.jpg'])
        assert.deepEqual(report.openOperations, [{
            operationId: 'open',
            imageId: 'open',
            phase: 'usage-repair-needed',
        }])
    })

    it('detects and repairs avatar inventory, references, usage, and operations', async () => {
        const data = new MemoryStore()
        const uploads = new MemoryStore()
        const now = Date.UTC(2026, 7, 5)
        const stale = now - 25 * 60 * 60 * 1000
        await data.setJSON('users/user-current.json', {
            id: 'user-current',
            avatarKey: 'current',
            recoveryKeyVersion: 1,
        })
        await data.setJSON('users/user-missing.json', {
            id: 'user-missing',
            avatarKey: 'missing-alias',
            recoveryKeyVersion: 1,
        })
        await data.setJSON('users/user-mismatch.json', {
            id: 'user-mismatch',
            avatarKey: 'foreign',
            recoveryKeyVersion: 1,
        })
        await data.setJSON('uploads/aliases/avatars/current.json', {
            imageId: 'current',
            userId: 'user-current',
            blobKey: 'avatars/user-current/current.png',
            size: 5,
            status: 'pending',
            operationId: 'current',
            createdAt: now,
        })
        await uploads.set('avatars/user-current/current.png', new Uint8Array(5))
        await data.setJSON('operations/avatar-updates/current.json', {
            version: 1,
            operationId: 'current',
            userId: 'user-current',
            oldAvatarId: '',
            newAvatarId: 'current',
            blobKey: 'avatars/user-current/current.png',
            size: 5,
            phase: 'repair-needed',
            usageApplied: true,
            createdAt: now,
            updatedAt: now,
        })
        await data.setJSON('repairs/avatar-update/current.json', {
            operationId: 'current',
            status: 'open',
        })
        await data.setJSON('uploads/aliases/avatars/stale.json', {
            imageId: 'stale',
            userId: 'user-current',
            blobKey: 'avatars/user-current/stale.png',
            size: 3,
            status: 'pending',
            createdAt: stale,
        })
        await uploads.set('avatars/user-current/stale.png', new Uint8Array(3))
        await data.setJSON('uploads/aliases/avatars/unreferenced.json', {
            imageId: 'unreferenced',
            userId: 'user-current',
            blobKey: 'avatars/user-current/unreferenced.png',
            size: 7,
            status: 'active',
            createdAt: now,
        })
        await uploads.set('avatars/user-current/unreferenced.png', new Uint8Array(7))
        await data.setJSON('uploads/aliases/avatars/foreign.json', {
            imageId: 'foreign',
            userId: 'user-current',
            blobKey: 'avatars/user-current/foreign.png',
            size: 2,
            status: 'active',
            createdAt: now,
        })
        await uploads.set('avatars/user-current/foreign.png', new Uint8Array(2))
        await data.setJSON('uploads/aliases/avatars/statusless.json', {
            imageId: 'statusless',
            userId: 'user-current',
            blobKey: 'avatars/user-current/statusless.png',
            size: 6,
            createdAt: now,
        })
        await uploads.set('avatars/user-current/statusless.png', new Uint8Array(6))
        await data.setJSON('uploads/aliases/avatars/dangling.json', {
            imageId: 'dangling',
            userId: 'user-current',
            blobKey: 'avatars/user-current/dangling.png',
            size: 4,
            status: 'active',
            createdAt: now,
        })
        await uploads.set('avatars/user-current/orphan.png', new Uint8Array(9))
        await data.setJSON('usage/uploads.json', { uploadedBytes: 99 })

        const report = await auditUploadStorage(data, uploads, { now })
        assert.deepEqual(report.referencedPendingAvatars, ['current'])
        assert.deepEqual(report.stalePendingAvatars, ['stale'])
        assert.deepEqual(report.unreferencedActiveAvatars.sort(), [
            'dangling',
            'unreferenced',
        ])
        assert.deepEqual(report.missingAvatarAliases, ['missing-alias'])
        assert.deepEqual(report.invalidAvatarOwnership, ['user-mismatch:foreign'])
        assert.ok(report.invalidAliases.includes('statusless'))
        assert.deepEqual(report.danglingAliases, ['dangling'])
        assert.deepEqual(report.orphanBlobs, ['avatars/user-current/orphan.png'])
        assert.equal(report.openOperations.length, 1)
        assert.equal(report.repairMarkers.length, 1)
        assert.notEqual(report.usageDelta, 0)

        const fixed = await auditUploadStorage(data, uploads, { fix: true, now })
        assert.ok(fixed.repaired > 0)
        assert.deepEqual(fixed.danglingAliases, [])
        assert.deepEqual(fixed.orphanBlobs, [])
        assert.deepEqual(fixed.missingAvatarAliases, [])
        assert.deepEqual(fixed.invalidAvatarOwnership, [])
        assert.deepEqual(fixed.invalidAliases, [])
        assert.deepEqual(fixed.referencedPendingAvatars, [])
        assert.deepEqual(fixed.stalePendingAvatars, [])
        assert.deepEqual(fixed.unreferencedActiveAvatars, [])
        assert.deepEqual(fixed.openOperations, [])
        assert.deepEqual(fixed.repairMarkers, [])
        assert.equal(fixed.usageDelta, 0)
        assert.equal(fixed.usageBytes, 5)
        assert.equal(
            await uploads.get('avatars/user-current/statusless.png', {
                type: 'arrayBuffer',
            }),
            null,
        )
        assert.equal(
            (await data.get('uploads/aliases/avatars/current.json', { type: 'json' })).status,
            'active',
        )
        assert.equal(
            (await data.get('users/user-missing.json', { type: 'json' })).avatarKey,
            '',
        )
        assert.equal(
            (await data.get('operations/avatar-updates/current.json', { type: 'json' })).phase,
            'committed',
        )

        await data.setJSON('repairs/avatar-update/current.json', {
            operationId: 'current',
            status: 'open',
        })
        const terminalMarkerFixed = await auditUploadStorage(data, uploads, {
            fix: true,
            now,
        })
        assert.deepEqual(terminalMarkerFixed.repairMarkers, [])
    })
})
