import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blobKeys } from '../server/domain/blob-keys.js'
import { createComment, setLike } from '../server/comments.js'
import { MemoryStore } from '../server/storage.js'
import { rebuildCommentViews } from '../scripts/rebuild-comment-views.mjs'

const user = { id: 'repair-user', name: '修复用户', avatarKey: '' }

describe('rebuild comment views', () => {
    it('is read-only by default and reports damaged views', async () => {
        const data = new MemoryStore()
        const created = await createComment(data, user, { comment: '待检查' })
        await data.delete(blobKeys.commentPublicView(created.id))
        await data.setJSON(blobKeys.comment(created.id), {
            ...(await data.get(blobKeys.comment(created.id), { type: 'json' })),
            likes: 7,
        })
        const before = new Map(data.values)

        const report = await rebuildCommentViews(data)

        assert.equal(report.aborted, false)
        assert.equal(report.mode, 'report')
        assert.ok(report.issues.some(issue => issue.type === 'public-view'))
        assert.ok(report.issues.some(issue => issue.type === 'like-count'))
        assert.deepEqual(data.values, before, '默认报告模式不得写入')
    })

    it('requires explicit confirmation for writes', async () => {
        const data = new MemoryStore()
        await createComment(data, user, { comment: '确认参数' })
        const result = await rebuildCommentViews(data, { fix: true })
        assert.equal(result.aborted, true)
        assert.equal(result.reason, 'missing-confirm')
    })

    it('repairs canonical counts, public/user/latest views and markers idempotently', async () => {
        const data = new MemoryStore()
        const first = await createComment(data, user, { comment: '第一条' })
        const second = await createComment(data, user, { comment: '第二条' })
        await setLike(data, first.id, user, true)
        const firstBody = await data.get(blobKeys.comment(first.id), { type: 'json' })
        firstBody.likes = 99
        await data.setJSON(blobKeys.comment(first.id), firstBody)
        await data.setJSON(blobKeys.commentPublicView(first.id), { broken: true })
        await data.delete(blobKeys.commentByUser(user.id, second.id))
        await data.setJSON(blobKeys.commentsLatestView, { version: 1, items: 'broken' })
        await data.setJSON(blobKeys.commentViewRepair(first.id), {
            commentId: first.id,
            status: 'open',
        })

        const fixed = await rebuildCommentViews(data, {
            fix: true,
            confirmProductionRepair: true,
        })
        assert.equal(fixed.aborted, false)
        assert.equal((await data.get(blobKeys.comment(first.id), { type: 'json' })).likes, 1)
        assert.equal((await data.get(blobKeys.commentPublicView(first.id), { type: 'json' })).likes, 1)
        assert.ok(await data.get(blobKeys.commentByUser(user.id, second.id), { type: 'json' }))
        assert.deepEqual(
            (await data.get(blobKeys.commentsLatestView, { type: 'json' })).items.map(item => item.id),
            [second.id, first.id].sort((left, right) => right - left),
        )
        assert.equal(await data.get(blobKeys.commentViewRepair(first.id), { type: 'json' }), null)

        const secondRun = await rebuildCommentViews(data, {
            fix: true,
            confirmProductionRepair: true,
        })
        assert.equal(secondRun.issues.length, 0)
    })

    it('removes orphan views left by interrupted deletes', async () => {
        const data = new MemoryStore()
        const id = 1752000000000777
        await data.setJSON(blobKeys.commentPublicView(id), {
            id,
            number: 1,
            displayId: 1,
            uid: user.id,
            sender: user.name,
            avatar: '',
            comment: '孤立视图',
            image: '',
            replyid: null,
            hidden: false,
            likes: 0,
            liked: false,
            createdAt: Date.now(),
            time: Math.floor(Date.now() / 1000),
        })
        await data.setJSON(blobKeys.commentByUser(user.id, id), {
            id,
            number: 1,
            comment: '孤立视图',
            uid: user.id,
            time: 1,
        })

        const report = await rebuildCommentViews(data)
        assert.equal(report.orphanPublic.length, 1)
        assert.equal(report.orphanUser.length, 1)

        await rebuildCommentViews(data, {
            fix: true,
            confirmProductionRepair: true,
        })
        assert.equal(await data.get(blobKeys.commentPublicView(id), { type: 'json' }), null)
        assert.equal(await data.get(blobKeys.commentByUser(user.id, id), { type: 'json' }), null)
    })

    it('retains unresolved markers when canonical numbering is invalid', async () => {
        const data = new MemoryStore()
        const id = 1752000000000666
        await data.setJSON(blobKeys.comment(id), {
            id,
            number: 0,
            uid: user.id,
            sender: user.name,
            avatar: '',
            comment: '无效编号',
            image: '',
            replyid: null,
            hidden: false,
            likes: 0,
            version: 1,
            createdAt: Date.now(),
            time: Math.floor(Date.now() / 1000),
        })
        await data.setJSON(blobKeys.commentViewRepair(id), {
            commentId: id,
            reason: 'create-read-model',
            status: 'open',
        })

        const result = await rebuildCommentViews(data, {
            fix: true,
            confirmProductionRepair: true,
        })
        assert.ok(result.issues.some(issue => issue.type === 'invalid-number'))
        assert.ok(await data.get(blobKeys.commentViewRepair(id), { type: 'json' }))
    })
})
