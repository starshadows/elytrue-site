import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { auditCommentLikes } from '../scripts/audit-comment-likes.mjs'
import { auditUploadStorage } from '../scripts/audit-upload-storage.mjs'
import { MemoryStore } from '../server/storage.js'
import { createComment } from '../server/comments.js'
import { blobKeys } from '../server/domain/blob-keys.js'

describe('comment like audit', () => {
    it('reports and repairs canonical/read-view differences without touching like facts', async () => {
        const data = new MemoryStore()
        const created = await createComment(data, {
            id: 'user-owner', name: '作者', avatarKey: '',
        }, { comment: '审计留言' }, { idFactory: () => 1234567890123456 })
        const commentId = created.id
        await data.setJSON(`likes/${commentId}/user-a.json`, { userId: 'user-a' })
        await data.setJSON(`likes/${commentId}/user-b.json`, { userId: 'user-b' })
        const canonical = await data.get(blobKeys.comment(commentId), { type: 'json' })
        canonical.likes = 1
        await data.setJSON(blobKeys.comment(commentId), canonical)
        await data.setJSON(blobKeys.commentViewRepair(commentId), {
            commentId,
            status: 'open',
        })

        const report = await auditCommentLikes(data)
        assert.equal(report.differences.length, 1)
        assert.equal(report.differences[0].cached, 1)
        assert.equal(report.differences[0].actual, 2)

        const fixed = await auditCommentLikes(data, { fix: true })
        assert.equal(fixed.repaired, 1)
        assert.equal(
            (await data.get(blobKeys.comment(commentId), { type: 'json' })).likes,
            2,
        )
        assert.equal(await data.get(blobKeys.commentViewRepair(commentId), { type: 'json' }), null)
        assert.equal(
            (await data.get(blobKeys.commentPublicView(commentId), { type: 'json' })).likes,
            2,
        )
        assert.ok(await data.get(`likes/${commentId}/user-a.json`, { type: 'json' }))
    })

    it('does not consume a non-like read-model repair marker', async () => {
        const data = new MemoryStore()
        const created = await createComment(data, {
            id: 'user-owner', name: '作者', avatarKey: '',
        }, { comment: '其他修复' })
        await data.setJSON(blobKeys.commentViewRepair(created.id), {
            commentId: created.id,
            reason: 'latest-view',
            status: 'open',
        })
        await auditCommentLikes(data, { fix: true })
        assert.ok(await data.get(blobKeys.commentViewRepair(created.id), { type: 'json' }))
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
