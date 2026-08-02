import assert from 'node:assert/strict'
import { mkdtempSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'
import { MemoryStore } from '../server/storage.js'
import { runCommentIndexMigration } from '../scripts/rebuild-comment-indexes.mjs'
import { shanghaiDateString } from '../server/comments.js'

class FlakyStore extends MemoryStore {
    constructor(failures = {}) {
        super()
        this.failures = failures
    }

    async setJSON(key, value, options = {}) {
        if (this.failures.setJSON?.(key, options)) throw new Error('injected setJSON failure')
        return super.setJSON(key, value, options)
    }
}

function commentKey(id) {
    return `comments/${String(id).padStart(16, '0')}.json`
}

function seedComment(store, { id, createdAt, uid = 'u1', text = `留言${id}` }) {
    return store.setJSON(commentKey(id), {
        id,
        uid,
        sender: '迁移用户',
        comment: text,
        image: '',
        hidden: false,
        createdAt,
        time: Math.floor(createdAt / 1000),
    })
}

function seedMigrated(store, { id, createdAt, number, uid = 'u1' }) {
    return Promise.all([
        seedComment(store, { id, createdAt, uid }),
        store.setJSON(`indexes/comments/number/${number}.json`, { commentId: id, createdAt }),
        store.setJSON(`dates/${shanghaiDateString(createdAt)}/${String(id).padStart(16, '0')}.json`, { commentId: id, createdAt }),
        store.setJSON(`indexes/comments/by-user/${uid}/${String(id).padStart(16, '0')}.json`, { commentId: id, createdAt }),
    ]).then(async () => {
        const body = await store.get(commentKey(id), { type: 'json' })
        body.number = number
        await store.setJSON(commentKey(id), body)
    })
}

let workDir

before(() => {
    workDir = mkdtempSync(join(tmpdir(), 'elytrue-migration-'))
})

after(() => {
    // 保留目录以便失败时排查
})

const FIX_CONFIRM = { fix: true, confirmProductionMigration: true, quiet: true }

describe('comment index migration', () => {
    it('assigns stable numbers to all-legacy comments sorted by createdAt', async () => {
        const store = new MemoryStore()
        await seedComment(store, { id: 300, createdAt: 3000 })
        await seedComment(store, { id: 100, createdAt: 1000 })
        await seedComment(store, { id: 200, createdAt: 2000 })

        const result = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(result.aborted, false)
        assert.equal(result.validation.length, 0)
        assert.deepEqual(result.report.assigned.map(entry => entry.id), [100, 200, 300])
        assert.deepEqual(result.report.assigned.map(entry => entry.number), [1, 2, 3])

        const seat1 = await store.get('indexes/comments/number/1.json', { type: 'json' })
        assert.equal(Number(seat1.commentId), 100)
        const body = await store.get(commentKey(100), { type: 'json' })
        assert.equal(body.number, 1)
        assert.equal(await store.get(`dates/${shanghaiDateString(1000)}/${String(100).padStart(16, '0')}.json`, { type: 'json' }) != null, true)
        assert.equal(await store.get(`indexes/comments/by-user/u1/${String(100).padStart(16, '0')}.json`, { type: 'json' }) != null, true)
    })

    it('treats fully migrated data as healthy and is idempotent', async () => {
        const store = new MemoryStore()
        await seedMigrated(store, { id: 100, createdAt: 1000, number: 1 })
        await seedMigrated(store, { id: 200, createdAt: 2000, number: 2 })

        const first = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(first.aborted, false)
        assert.equal(first.validation.length, 0)
        assert.equal(first.report.executed.length, 0, '无缺口的健康数据不应有写入')

        const second = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(second.report.executed.length, 0, '重复运行应幂等')
        assert.equal(second.report.assigned.length, 0)
    })

    it('aborts by default on mixed numbering and requires an explicit flag', async () => {
        const store = new MemoryStore()
        await seedComment(store, { id: 100, createdAt: 1000 })
        await seedMigrated(store, { id: 200, createdAt: 2000, number: 1 })

        const aborted = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(aborted.aborted, true)
        assert.equal(aborted.reason, 'mixed-numbering')
        const body = await store.get(commentKey(100), { type: 'json' })
        assert.equal(body.number, undefined, '中止时不得修改任何数据')

        const allowed = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            allowMixedNumbering: true,
            quiet: true,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(allowed.aborted, false)
        assert.equal(allowed.validation.length, 0)
        assert.equal(Number((await store.get(commentKey(100), { type: 'json' })).number), 2, '旧留言编号排在新留言之后')
    })

    it('refuses to fix without the explicit production confirmation', async () => {
        const store = new MemoryStore()
        await seedComment(store, { id: 100, createdAt: 1000 })
        const result = await runCommentIndexMigration(store, {
            fix: true,
            quiet: true,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(result.aborted, true)
        assert.equal(result.reason, 'missing-confirm')
        assert.equal((await store.get(commentKey(100), { type: 'json' })).number, undefined)
    })

    it('skips number seats already claimed by another comment', async () => {
        const store = new MemoryStore()
        await seedComment(store, { id: 100, createdAt: 1000 })
        await seedComment(store, { id: 200, createdAt: 2000 })
        await seedComment(store, { id: 300, createdAt: 3000 })
        // 预置一个被占用的编号 1(指向 100,但 100 尚未迁移编号)
        await store.setJSON('indexes/comments/number/1.json', { commentId: 100, createdAt: 1000 })

        const result = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(result.aborted, false)
        const assigned = result.report.assigned.map(entry => entry.number)
        assert.ok(!assigned.includes(1), '不得重复认领已占用的编号')
        assert.equal(new Set(assigned).size, assigned.length)
        // 预置冲突仍会被校验报告(脚本不覆盖他人占位)
        assert.ok(
            result.validation.some(issue => issue.includes('编号 1') || issue.includes('与编号索引不一致')),
            '冲突应出现在校验报告中',
        )
    })

    it('writes a manifest with body snapshots and index key lists before changing data', async () => {
        const store = new MemoryStore()
        await seedComment(store, { id: 100, createdAt: 1000 })
        const dir = mkdtempSync(join(tmpdir(), 'elytrue-manifest-'))
        const result = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            manifestDir: dir,
            reportDir: dir,
        })
        assert.ok(result.manifestPath)
        assert.equal(existsSync(result.manifestPath), true)
        const manifest = JSON.parse(readFileSync(result.manifestPath, 'utf8'))
        assert.equal(manifest.comments.length, 1)
        assert.equal(manifest.comments[0].bodySnapshot.comment, '留言100')
        assert.equal(manifest.comments[0].numberBefore, null)
        assert.ok(manifest.comments[0].indexKeys.seat.includes('indexes/comments/number/'))
        assert.ok(manifest.comments[0].indexKeys.date.startsWith('dates/'))
        assert.ok(manifest.comments[0].indexKeys.byUser.startsWith('indexes/comments/by-user/'))
    })

    it('recovers from a mid-migration failure after restoring the partial writes', async () => {
        const store = new FlakyStore({})
        await seedComment(store, { id: 100, createdAt: 1000 })
        await seedComment(store, { id: 200, createdAt: 2000 })
        await seedComment(store, { id: 300, createdAt: 3000 })

        // 第 2 条留言(按 createdAt 排序)的正文写入失败
        store.failures = {
            setJSON: (key, options) => key === commentKey(200),
        }
        await assert.rejects(
            () => runCommentIndexMigration(store, {
                ...FIX_CONFIRM,
                manifestDir: workDir,
                reportDir: workDir,
            }),
            /injected setJSON failure/u,
        )
        // 失败运行留下悬空占位:200 的编号 2 已认领但正文从未写入 number
        const danglingSeat = await store.get('indexes/comments/number/2.json', { type: 'json' })
        assert.equal(Number(danglingSeat.commentId), 200)
        assert.equal((await store.get(commentKey(200), { type: 'json' })).number, undefined)

        // 未清理前重跑会被「新旧混合编号」安全拦截
        store.failures = {}
        const blocked = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(blocked.aborted, true)
        assert.equal(blocked.reason, 'mixed-numbering')

        // 按备份恢复:清理失败运行残留的悬空占位后重跑,必须补齐且不产生重复编号
        await store.delete('indexes/comments/number/2.json')
        const result = await runCommentIndexMigration(store, {
            ...FIX_CONFIRM,
            allowMixedNumbering: true,
            quiet: true,
            manifestDir: workDir,
            reportDir: workDir,
        })
        assert.equal(result.aborted, false)
        assert.equal(result.validation.length, 0, '重跑后必须完整一致')
        assert.deepEqual(result.report.assigned.map(entry => entry.number), [2, 3])
        const numbers = result.report.assigned.map(entry => entry.number)
        assert.equal(new Set([1, ...numbers]).size, 3)
        // 备份依据:清单与报告都留在 workDir
        assert.ok(readdirSync(workDir).some(file => file.includes('rebuild-comment-indexes')))
    })
})
