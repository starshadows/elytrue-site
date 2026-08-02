import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handleApiRequest } from '../server/app.js'
import { MemoryStore } from '../server/storage.js'
import { createComment, newCommentId, shanghaiDateString } from '../server/comments.js'

class FlakyStore extends MemoryStore {
    constructor(failures = {}) {
        super()
        this.failures = failures
    }

    async setJSON(key, value, options = {}) {
        if (this.failures.setJSON?.(key, options)) throw new Error('injected setJSON failure')
        return super.setJSON(key, value, options)
    }

    async delete(key) {
        if (this.failures.delete?.(key)) throw new Error('injected delete failure')
        return super.delete(key)
    }
}

function idSequence(ids) {
    let index = 0
    return () => (index < ids.length ? ids[index++] : newCommentId())
}

const user = { id: 'unit-user', name: '单元用户', avatarKey: '' }

const origin = 'https://preview.elytrue.test'
const env = {
    ELYTRUE_APP_SECRET: 'test-only-secret-that-is-longer-than-thirty-two-characters',
    RESEND_API_KEY: 're_test_only',
    PUBLIC_SITE_URL: origin,
    ADMIN_BOOTSTRAP_SECRET: 'test-admin-bootstrap-secret',
    ALLOWED_ORIGINS: origin,
}

function createState(ip = '127.0.0.1') {
    return {
        ip,
        jar: new Map(),
        csrfToken: '',
        stores: { data: new MemoryStore(), uploads: new MemoryStore() },
    }
}

function updateCookies(jar, response) {
    const values = response.headers.getSetCookie?.()
        || (response.headers.get('set-cookie') ? response.headers.get('set-cookie').split(', ') : [])
    for (const value of values) {
        const pair = value.split(';', 1)[0]
        const separator = pair.indexOf('=')
        const key = pair.slice(0, separator)
        const content = decodeURIComponent(pair.slice(separator + 1))
        if (content) jar.set(key, content)
        else jar.delete(key)
    }
}

async function call(state, method, path, body, options = {}) {
    const headers = new Headers(options.headers || {})
    headers.set('Origin', origin)
    if (state.jar.size) {
        headers.set('Cookie', [...state.jar].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; '))
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && state.csrfToken) {
        headers.set('X-CSRF-Token', state.csrfToken)
    }
    let requestBody
    if (body !== undefined) {
        headers.set('Content-Type', 'application/json')
        requestBody = JSON.stringify(body)
    }
    const request = new Request(`${origin}/api/${path}`, {
        method,
        headers,
        body: requestBody,
    })
    const response = await handleApiRequest({
        request,
        env: options.env || env,
        clientIp: state.ip,
    }, state.stores)
    updateCookies(state.jar, response)
    const payload = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : null
    if (typeof payload?.data?.csrfToken === 'string') {
        state.csrfToken = payload.data.csrfToken
    }
    return { response, payload }
}

async function register(state, name, email, password = 'a-secure-password') {
    const result = await call(state, 'POST', 'user/register', { name, email, password })
    assert.equal(result.response.status, 201)
}

async function postComment(state, comment, extra = {}) {
    const result = await call(state, 'POST', 'comments/post', { comment, ...extra })
    assert.equal(result.response.status, 201)
    return result.payload.data
}

describe('stable public comment numbers', () => {
    const state = createState('10.0.5.1')
    const published = {}

    it('assigns stable numbers on publish', async () => {
        await register(state, '编号用户', 'num@example.com')
        published.a = await postComment(state, '第一条')
        published.b = await postComment(state, '第二条')
        published.c = await postComment(state, '第三条')
        assert.equal(published.a.number, 1)
        assert.equal(published.b.number, 2)
        assert.equal(published.c.number, 3)
    })

    it('keeps numbers stable after deleting another comment', async () => {
        const deleteResult = await call(state, 'POST', 'admin/bootstrap', undefined, {
            headers: { 'X-Admin-Bootstrap-Secret': env.ADMIN_BOOTSTRAP_SECRET },
        })
        assert.equal(deleteResult.response.status, 200)
        const removed = await call(state, 'POST', 'admin/comments/moderate', {
            commentId: published.b.id,
            action: 'delete',
        })
        assert.equal(removed.response.status, 200)

        const listed = await call(state, 'GET', 'comments?count=10')
        const numbers = listed.payload.data.map(comment => comment.displayId)
        assert.deepEqual(numbers, [3, 1])
        assert.deepEqual(listed.payload.data.map(comment => comment.comment), ['第三条', '第一条'])

        // 新留言取得未占用的 4
        published.d = await postComment(state, '第四条')
        assert.equal(published.d.number, 4)
    })

    it('jumps by public number and replies by public number', async () => {
        const jump = await call(state, 'GET', 'comments?number=3')
        assert.equal(jump.response.status, 200)
        assert.equal(jump.payload.data[0].comment, '第三条')
        assert.equal(jump.payload.data[0].displayId, 3)

        const reply = await postComment(state, '回复第一条', { replyid: 1 })
        assert.equal(reply.number, 5)
        assert.equal(reply.replyid, published.a.id, 'replyid 应解析为内部 ID')
        published.reply = reply
    })

    it('keeps numbers unaffected by hide and restore', async () => {
        const hidden = await call(state, 'POST', 'admin/comments/moderate', {
            commentId: published.reply.id,
            action: 'hide',
        })
        assert.equal(hidden.response.status, 200)
        const adminView = await call(state, 'GET', 'comments?count=10')
        const afterHide = adminView.payload.data.find(comment => comment.comment === '回复第一条')
        assert.equal(afterHide.displayId, 5)
        assert.equal(afterHide.hidden, true)

        const restored = await call(state, 'POST', 'admin/comments/moderate', {
            commentId: published.reply.id,
            action: 'restore',
        })
        assert.equal(restored.response.status, 200)
        const afterRestore = await call(state, 'GET', 'comments?number=5')
        assert.equal(afterRestore.payload.data[0].displayId, 5)
    })

    it('still resolves legacy internal ids in from and replyid', async () => {
        const legacyId = 1752000000000000
        await state.stores.data.setJSON(`comments/${String(legacyId).padStart(16, '0')}.json`, {
            id: legacyId,
            uid: 'legacy-uid',
            sender: '旧用户',
            comment: '旧数据留言',
            image: '',
            hidden: false,
            createdAt: Date.now() - 86400000,
            time: Math.floor((Date.now() - 86400000) / 1000),
        })

        const byId = await call(state, 'GET', `comments?from=${legacyId}&count=1`)
        assert.equal(byId.payload.data[0].comment, '旧数据留言')

        const replyToLegacy = await postComment(state, '回复旧留言', { replyid: legacyId })
        assert.equal(replyToLegacy.replyid, legacyId)
    })

    it('assigns distinct numbers to concurrent posts', async () => {
        const pair = [createState('10.0.5.2'), createState('10.0.5.3')]
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        pair.forEach(state => { state.stores = stores })
        await register(pair[0], '并发甲', 'conc-a@example.com')
        await register(pair[1], '并发乙', 'conc-b@example.com')

        const results = await Promise.all([
            call(pair[0], 'POST', 'comments/post', { comment: '并发留言一' }),
            call(pair[1], 'POST', 'comments/post', { comment: '并发留言二' }),
        ])
        assert.deepEqual(results.map(result => result.response.status), [201, 201])
        const numbers = results.map(result => result.payload.data.number)
        assert.equal(new Set(numbers).size, 2)
        assert.deepEqual(numbers.slice().sort(), numbers)
    })
})

describe('today comment count in Asia/Shanghai', () => {
    const state = createState('10.0.6.1')

    it('counts comments by Shanghai natural day', async () => {
        await register(state, '计数用户', 'count@example.com')
        await postComment(state, '今天第一条')
        await postComment(state, '今天第二条')
        const today = shanghaiDateString(Date.now())
        const count = await call(state, 'GET', `comments/count?date=${today}`)
        assert.equal(count.response.status, 200)
        assert.equal(count.payload.data, 2)
    })

    it('does not mix comments across date boundaries', async () => {
        const yesterday = new Date(Date.now() - 86400000)
        const yesterdayStr = shanghaiDateString(yesterday.getTime())
        const today = shanghaiDateString(Date.now())
        if (yesterdayStr === today) return

        await state.stores.data.setJSON(`dates/${yesterdayStr}/${'1'.padStart(16, '0')}.json`, {
            commentId: 1,
            createdAt: yesterday.getTime(),
        })
        const yCount = await call(state, 'GET', `comments/count?date=${yesterdayStr}`)
        assert.equal(yCount.payload.data, 1)
        const tCount = await call(state, 'GET', `comments/count?date=${today}`)
        assert.equal(tCount.payload.data, 2)
    })

    it('maps timestamps near midnight to the correct Shanghai date', () => {
        assert.equal(shanghaiDateString(new Date('2026-08-01T16:30:00Z').getTime()), '2026-08-02')
        assert.equal(shanghaiDateString(new Date('2026-08-01T15:59:59Z').getTime()), '2026-08-01')
    })

    it('rejects malformed dates', async () => {
        const bad = await call(state, 'GET', 'comments/count?date=2026-13-99')
        assert.equal(bad.response.status, 400)
    })
})

describe('user comment pagination', () => {
    const state = createState('10.0.7.1')

    it('returns hasMore and cursor-driven pages', async () => {
        await register(state, '分页用户', 'page@example.com')
        await postComment(state, '页一')
        for (let i = 0; i < 3; i += 1) await postComment(state, `补充 ${i}`)
        await postComment(state, '页二')

        const uid = await call(state, 'GET', 'user/me')
        const userId = uid.payload.data.id

        const firstPage = await call(state, 'GET', `comments?uid=${userId}&count=3`)
        assert.equal(firstPage.payload.data.items.length, 3)
        assert.equal(firstPage.payload.data.hasMore, true)

        const cursor = firstPage.payload.data.items[2].id
        const secondPage = await call(state, 'GET', `comments?uid=${userId}&count=3&cursor=${cursor}`)
        assert.equal(secondPage.payload.data.items.length, 2)
        assert.equal(secondPage.payload.data.hasMore, false)

        const allIds = [...firstPage.payload.data.items, ...secondPage.payload.data.items].map(item => item.id)
        assert.equal(new Set(allIds).size, 5, 'cursor 分页不得重复或遗漏')
        assert.deepEqual(allIds, [...allIds].sort((a, b) => b - a), '应保持时间倒序')

        const exactPage = await call(state, 'GET', `comments?uid=${userId}&count=5`)
        assert.equal(exactPage.payload.data.items.length, 5)
        assert.equal(exactPage.payload.data.hasMore, false)
    })
})

describe('upload lifecycle and orphan cleanup', () => {
    const state = createState('10.0.8.1')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nfsAAAAASUVORK5CYII='

    it('marks uploads pending, active after posting, and allows deleting pending ones', async () => {
        await register(state, '上传用户', 'upload@example.com')

        const first = await call(state, 'POST', 'uploads/image', { image: png })
        const second = await call(state, 'POST', 'uploads/image', { image: png })
        assert.equal(first.response.status, 201)
        assert.equal(second.response.status, 201)
        const firstId = first.payload.data.imageId
        const secondId = second.payload.data.imageId

        // 未关联前是 pending,可删除
        const alias = await state.stores.data.get(`uploads/aliases/comments/${secondId}.json`, { type: 'json' })
        assert.equal(alias.status, 'pending')
        const removed = await call(state, 'DELETE', `uploads/image?imageId=${secondId}`)
        assert.equal(removed.response.status, 200)
        assert.equal(await state.stores.data.get(`uploads/aliases/comments/${secondId}.json`, { type: 'json' }), null)

        // 关联留言后变为 active,不可删除
        const posted = await postComment(state, '带图留言', { imageKeys: [firstId] })
        assert.equal(posted.number, 1)
        const active = await state.stores.data.get(`uploads/aliases/comments/${firstId}.json`, { type: 'json' })
        assert.equal(active.status, 'active')
        const blocked = await call(state, 'DELETE', `uploads/image?imageId=${firstId}`)
        assert.equal(blocked.response.status, 409)

        // 他人图片不可删除
        const stranger = createState('10.0.8.2')
        stranger.stores = state.stores
        await register(stranger, '路人', 'stranger@example.com')
        const third = await call(state, 'POST', 'uploads/image', { image: png })
        const thirdId = third.payload.data.imageId
        const denied = await call(stranger, 'DELETE', `uploads/image?imageId=${thirdId}`)
        assert.equal(denied.response.status, 404)
    })

    it('keeps uploaded images deletable when a multi-image comment fails', async () => {
        const ok = await call(state, 'POST', 'uploads/image', { image: png })
        const bad = await call(state, 'POST', 'uploads/image', { image: png })
        assert.equal(ok.response.status, 201)
        assert.equal(bad.response.status, 201)
        const okId = ok.payload.data.imageId
        const badId = bad.payload.data.imageId

        // 第二条引用失效图片 → 留言失败,两张都保持 pending 可清理
        const failed = await call(state, 'POST', 'comments/post', {
            comment: '失败留言',
            imageKeys: [okId, badId, '00000000-0000-0000-0000-000000000000'],
        })
        assert.equal(failed.response.status, 400)

        for (const imageId of [okId, badId]) {
            const cleanup = await call(state, 'DELETE', `uploads/image?imageId=${imageId}`)
            assert.equal(cleanup.response.status, 200)
        }
    })
})

describe('createComment failure paths', () => {
    it('retries with a fresh internal id on collision and points the number seat at the persisted id', async () => {
        const data = new MemoryStore()
        const collidingId = 1234567890123000
        await data.setJSON(`comments/${String(collidingId).padStart(16, '0')}.json`, {
            id: collidingId, uid: 'other', comment: '占位',
        })
        const comment = await createComment(data, user, { comment: '第一条' }, {
            idFactory: idSequence([collidingId, 9876543210123000]),
        })
        assert.equal(comment.id, 9876543210123000)
        assert.equal(comment.number, 1)
        const seat = await data.get('indexes/comments/number/1.json', { type: 'json' })
        assert.equal(Number(seat.commentId), 9876543210123000, '编号索引必须指向实际写入的内部 ID')
    })

    it('rejects after five consecutive internal id collisions without returning data', async () => {
        const data = new MemoryStore()
        const collidingId = 1111111111111000
        await data.setJSON(`comments/${String(collidingId).padStart(16, '0')}.json`, {
            id: collidingId, uid: 'other', comment: '占位',
        })
        const idFactory = () => collidingId
        await assert.rejects(
            () => createComment(data, user, { comment: '反复冲突' }, { idFactory }),
            error => error.status === 500,
        )
        assert.equal((await data.list({ prefix: 'comments/' })).blobs.length, 1, '不得留下半成品留言')
        assert.equal((await data.list({ prefix: 'indexes/comments/number/' })).blobs.length, 0)
        const captured = []
        const original = console.error
        console.error = (...args) => captured.push(args.join(' '))
        try {
            await assert.rejects(
                () => createComment(data, user, { comment: '反复冲突2' }, { idFactory }),
                error => error.status === 500,
            )
        } finally {
            console.error = original
        }
        assert.ok(captured.some(text => text.includes('comment_persist_conflict')))
    })

    it('fails cleanly when the comment body write throws a non-precondition error', async () => {
        const data = new FlakyStore({
            setJSON: key => key.startsWith('comments/'),
        })
        await assert.rejects(
            () => createComment(data, user, { comment: '正文异常' }, { idFactory: () => 9876543210123999 }),
            /injected setJSON failure/u,
        )
        assert.equal((await data.list({ prefix: 'comments/' })).blobs.length, 0)
        assert.equal((await data.list({ prefix: 'indexes/comments/number/' })).blobs.length, 0)
    })

    it('rolls back comment and seat when the user index write fails', async () => {
        const data = new FlakyStore({
            setJSON: key => key.startsWith('indexes/comments/by-user/'),
        })
        await assert.rejects(
            () => createComment(data, user, { comment: '索引失败' }, { idFactory: () => 9876543210123888 }),
            error => error.status === 500,
        )
        assert.equal((await data.list({ prefix: 'comments/' })).blobs.length, 0, '正文必须回滚')
        assert.equal((await data.list({ prefix: 'indexes/comments/number/' })).blobs.length, 0, '编号占位必须回滚')
        assert.equal((await data.list({ prefix: 'indexes/comments/by-user/' })).blobs.length, 0)
    })

    it('rolls back comment and seat when the date index write fails', async () => {
        const data = new FlakyStore({
            setJSON: key => key.startsWith('dates/'),
        })
        await assert.rejects(
            () => createComment(data, user, { comment: '日期索引失败' }, { idFactory: () => 9876543210123777 }),
            error => error.status === 500,
        )
        assert.equal((await data.list({ prefix: 'comments/' })).blobs.length, 0)
        assert.equal((await data.list({ prefix: 'indexes/comments/number/' })).blobs.length, 0)
    })

    it('logs a structured error when rollback itself fails', async () => {
        const data = new FlakyStore({
            setJSON: key => key.startsWith('indexes/comments/by-user/'),
            delete: key => key.startsWith('indexes/comments/number/'),
        })
        const captured = []
        const original = console.error
        console.error = (...args) => captured.push(args.join(' '))
        try {
            await assert.rejects(
                () => createComment(data, user, { comment: '回滚失败' }, { idFactory: () => 9876543210123666 }),
                error => error.status === 500,
            )
        } finally {
            console.error = original
        }
        assert.ok(captured.some(text => text.includes('comment_index_write_failed')))
        assert.ok(captured.some(text => text.includes('comment_rollback_failed')))
        assert.equal((await data.list({ prefix: 'comments/' })).blobs.length, 0, '正文仍应尝试回滚')
    })

    it('never returns success when any step fails', async () => {
        const failDate = new FlakyStore({ setJSON: key => key.startsWith('dates/') })
        const failUser = new FlakyStore({ setJSON: key => key.startsWith('indexes/comments/by-user/') })
        const results = await Promise.allSettled([
            createComment(failDate, user, { comment: 'x' }),
            createComment(failUser, user, { comment: 'y' }),
        ])
        assert.equal(results[0].status, 'rejected')
        assert.equal(results[1].status, 'rejected')
    })
})

describe('hard-delete related indexes', () => {
    const state = createState('10.0.9.1')

    it('keeps the number seat (gap), removes user index, keeps date count, and jumps to 404', async () => {
        await register(state, '删除用户', 'del@example.com')
        const c1 = await postComment(state, '甲')
        const c2 = await postComment(state, '乙')
        const c3 = await postComment(state, '丙')

        await call(state, 'POST', 'admin/bootstrap', undefined, {
            headers: { 'X-Admin-Bootstrap-Secret': env.ADMIN_BOOTSTRAP_SECRET },
        })
        const removed = await call(state, 'POST', 'admin/comments/moderate', {
            commentId: c2.id,
            action: 'delete',
        })
        assert.equal(removed.response.status, 200)

        // 编号占位保留:跳转空号返回 404,新留言从 4 开始
        const jump = await call(state, 'GET', 'comments?number=2')
        assert.equal(jump.response.status, 404)
        const d = await postComment(state, '丁')
        assert.equal(d.number, 4)
        assert.equal((await state.stores.data.get('indexes/comments/number/2.json', { type: 'json' })).commentId, c2.id)

        // 用户索引已删除:个人主页分页不含被删留言
        const me = await call(state, 'GET', 'user/me')
        const uid = me.payload.data.id
        const page = await call(state, 'GET', `comments?uid=${uid}&count=10`)
        assert.equal(page.payload.data.hasMore, false)
        assert.deepEqual(page.payload.data.items.map(item => item.comment), ['丁', '丙', '甲'])
        assert.equal(page.payload.data.items.some(item => item.id === c2.id), false)

        // 日期统计口径为「当天曾发布」:删除不扣减
        const today = shanghaiDateString(Date.now())
        const count = await call(state, 'GET', `comments/count?date=${today}`)
        assert.equal(count.payload.data, 4)
    })
})

describe('upload usage accounting', () => {
    const state = createState('10.0.10.1')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nfsAAAAASUVORK5CYII='

    async function usageBytes() {
        const usage = await state.stores.data.get('usage/uploads.json', { type: 'json' })
        return usage?.uploadedBytes ?? 0
    }

    async function upload() {
        const result = await call(state, 'POST', 'uploads/image', { image: png })
        assert.equal(result.response.status, 201)
        return result.payload.data.imageId
    }

    it('increments on upload, decrements on pending delete, and stays put for active images', async () => {
        await register(state, '用量用户', 'usage@example.com')
        const before = await usageBytes()
        const id1 = await upload()
        const id2 = await upload()
        const afterUploads = await usageBytes()
        assert.equal(afterUploads - before, 2 * Buffer.from(png, 'base64').length)

        // active 图片拒绝删除,统计不变
        const posted = await postComment(state, '带图', { imageKeys: [id1] })
        assert.equal(posted.number, 1)
        const rejected = await call(state, 'DELETE', `uploads/image?imageId=${id1}`)
        assert.equal(rejected.response.status, 409)
        assert.equal(await usageBytes(), afterUploads)

        // 删除 pending 后减少
        const removed = await call(state, 'DELETE', `uploads/image?imageId=${id2}`)
        assert.equal(removed.response.status, 200)
        assert.equal(await usageBytes(), afterUploads - Buffer.from(png, 'base64').length)

        // 重复删除 404,不重复扣减
        const again = await call(state, 'DELETE', `uploads/image?imageId=${id2}`)
        assert.equal(again.response.status, 404)
        assert.equal(await usageBytes(), afterUploads - Buffer.from(png, 'base64').length)
    })

    it('does not decrement when the blob delete fails', async () => {
        const id = await upload()
        const before = await usageBytes()
        const originalUploads = state.stores.uploads
        state.stores.uploads = new FlakyStore({ delete: () => true })
        try {
            const failed = await call(state, 'DELETE', `uploads/image?imageId=${id}`)
            assert.equal(failed.response.status, 500)
        } finally {
            state.stores.uploads = originalUploads
        }
        assert.equal(await usageBytes(), before, 'Blob 删除失败时统计不得先扣减')
        // 别名仍在,仍可正常删除
        const removed = await call(state, 'DELETE', `uploads/image?imageId=${id}`)
        assert.equal(removed.response.status, 200)
        assert.equal(await usageBytes(), before - Buffer.from(png, 'base64').length)
    })

    it('decrements for stale pending images cleaned up on the next upload', async () => {
        const stale = await upload()
        const staleAlias = await state.stores.data.get(`uploads/aliases/comments/${stale}.json`, { type: 'json' })
        staleAlias.createdAt = Date.now() - 25 * 60 * 60 * 1000
        await state.stores.data.setJSON(`uploads/aliases/comments/${stale}.json`, staleAlias)

        const before = await usageBytes()
        const fresh = await upload()
        const after = await usageBytes()
        const oneImage = Buffer.from(png, 'base64').length
        assert.equal(after, before - oneImage + oneImage, '旧 pending 被清理,新图计入')
        assert.equal(await state.stores.data.get(`uploads/aliases/comments/${stale}.json`, { type: 'json' }), null)
        assert.ok(fresh)
    })
})
