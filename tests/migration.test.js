import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { blobKeys } from '../server/domain/blob-keys.js'
import { createComment, setLike } from '../server/comments.js'
import { MemoryStore } from '../server/storage.js'
import { rebuildCommentViews } from '../scripts/rebuild-comment-views.mjs'
import { migrateUserUids } from '../scripts/migrate-user-uids.mjs'

const user = { id: 'repair-user', name: '修复用户', avatarKey: '' }

class FailingUidMigrationStore extends MemoryStore {
    failUserId = ''

    async setJSON(key, value, options = {}) {
        if (this.failUserId && key === blobKeys.user(this.failUserId) && value?.uid) {
            throw new Error('injected UID migration user write failure')
        }
        return super.setJSON(key, value, options)
    }
}

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
        const latest = await data.get(blobKeys.commentsLatestView, { type: 'json' })
        const revision = await data.get(blobKeys.commentsLatestRevision, { type: 'json' })
        assert.ok(Number.isSafeInteger(latest.snapshotRevision))
        assert.equal(revision.revision, latest.snapshotRevision)
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

describe('migrate user UIDs', () => {
    const users = [
        {
            id: '22222222-2222-4222-8222-222222222222',
            name: '同刻乙',
            createdAt: 1_700_000_000_000,
        },
        {
            id: '11111111-1111-4111-8111-111111111111',
            name: '同刻甲',
            createdAt: 1_700_000_000_000,
        },
        {
            id: '33333333-3333-4333-8333-333333333333',
            name: '稍后用户',
            createdAt: 1_700_000_001_000,
        },
    ]

    async function seedUsers(data) {
        for (const user of users) await data.setJSON(blobKeys.user(user.id), user)
    }

    it('is read-only by default and plans createdAt/UUID tie-break order', async () => {
        const data = new MemoryStore()
        await seedUsers(data)
        const before = new Map(data.values)

        const report = await migrateUserUids(data)

        assert.equal(report.aborted, false)
        assert.equal(report.mode, 'report')
        assert.deepEqual(report.planned, [
            { userId: users[1].id, uid: 1 },
            { userId: users[0].id, uid: 2 },
            { userId: users[2].id, uid: 3 },
        ])
        assert.deepEqual(data.values, before)
    })

    it('requires the explicit production confirmation before writing', async () => {
        const data = new MemoryStore()
        await seedUsers(data)
        const result = await migrateUserUids(data, { fix: true })
        assert.equal(result.aborted, true)
        assert.equal(result.reason, 'missing-confirm')
        assert.equal(await data.get(blobKeys.userUid(1), { type: 'json' }), null)
    })

    it('writes permanent seats, hint and schema and reruns idempotently', async () => {
        const data = new MemoryStore()
        await seedUsers(data)
        const fixed = await migrateUserUids(data, {
            fix: true,
            confirmProductionMigration: true,
        })
        assert.equal(fixed.aborted, false)
        assert.equal(fixed.maximumUid, 3)

        const expected = [users[1], users[0], users[2]]
        for (let index = 0; index < expected.length; index += 1) {
            const uid = index + 1
            const stored = await data.get(blobKeys.user(expected[index].id), { type: 'json' })
            const seat = await data.get(blobKeys.userUid(uid), { type: 'json' })
            assert.equal(stored.uid, uid)
            assert.equal(seat.userId, expected[index].id)
            assert.equal(seat.status, 'committed')
        }
        assert.equal((await data.get(blobKeys.userUidHint, { type: 'json' })).value, 3)
        assert.deepEqual(
            await data.get(blobKeys.userUidSchema, { type: 'json' }),
            {
                version: 1,
                status: 'ready',
                migratedAt: (await data.get(blobKeys.userUidSchema, { type: 'json' })).migratedAt,
                migratedUsers: 3,
                source: 'created-at-migration',
            },
        )

        const beforeRerun = new Map(data.values)
        const rerun = await migrateUserUids(data, {
            fix: true,
            confirmProductionMigration: true,
        })
        assert.equal(rerun.changed, 0)
        assert.deepEqual(rerun.planned, [])
        assert.deepEqual(data.values, beforeRerun)
    })

    it('continues a matching partial migration without renumbering', async () => {
        const data = new MemoryStore()
        await seedUsers(data)
        await data.setJSON(blobKeys.user(users[1].id), { ...users[1], uid: 1 })
        await data.setJSON(blobKeys.userUid(1), {
            uid: 1,
            userId: users[1].id,
            status: 'committed',
        })

        const fixed = await migrateUserUids(data, {
            fix: true,
            confirmProductionMigration: true,
        })
        assert.equal(fixed.aborted, false)
        assert.equal((await data.get(blobKeys.user(users[1].id), { type: 'json' })).uid, 1)
        assert.equal((await data.get(blobKeys.user(users[0].id), { type: 'json' })).uid, 2)
        assert.equal((await data.get(blobKeys.user(users[2].id), { type: 'json' })).uid, 3)
    })

    it('rolls back only the seat created for a failed user write', async () => {
        const data = new FailingUidMigrationStore()
        await seedUsers(data)
        data.failUserId = users[1].id

        await assert.rejects(
            migrateUserUids(data, {
                fix: true,
                confirmProductionMigration: true,
            }),
            /injected UID migration user write failure/u,
        )

        assert.equal(await data.get(blobKeys.userUid(1), { type: 'json' }), null)
        assert.equal(
            (await data.get(blobKeys.user(users[1].id), { type: 'json' })).uid,
            undefined,
        )
        assert.equal(await data.get(blobKeys.userUidSchema, { type: 'json' }), null)
    })

    it('aborts on UID, seat and orphan conflicts without writing', async () => {
        const data = new MemoryStore()
        await seedUsers(data)
        await data.setJSON(blobKeys.user(users[1].id), { ...users[1], uid: 2 })
        await data.setJSON(blobKeys.userUid(1), {
            uid: 1,
            userId: users[0].id,
            status: 'committed',
        })
        await data.setJSON(blobKeys.userUid(9), {
            uid: 9,
            userId: '99999999-9999-4999-8999-999999999999',
            status: 'committed',
        })
        const before = new Map(data.values)

        const result = await migrateUserUids(data, {
            fix: true,
            confirmProductionMigration: true,
        })

        assert.equal(result.aborted, true)
        assert.equal(result.reason, 'inconsistent-data')
        assert.ok(result.issues.some(issue => issue.type === 'uid-order-conflict'))
        assert.ok(result.issues.some(issue => issue.type === 'seat-owner-conflict'))
        assert.ok(result.issues.some(issue => issue.type === 'orphan-seat'))
        assert.deepEqual(data.values, before)
    })
})
