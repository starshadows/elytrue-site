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
})
