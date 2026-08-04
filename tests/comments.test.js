import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handleApiRequest } from '../server/app.js'
import { MemoryStore } from '../server/storage.js'
import { createComment, listComments, newCommentId, setLike, shanghaiDateString } from '../server/comments.js'
import { resetMemoryRateLimitsForTests } from '../server/rate-limit.js'

class FlakyStore extends MemoryStore {
    constructor(failures = {}) {
        super()
        this.failures = failures
    }

    async setJSON(key, value, options = {}) {
        if (this.failures.setJSON?.(key, options, value)) throw new Error('injected setJSON failure')
        return super.setJSON(key, value, options)
    }

    async delete(key) {
        if (this.failures.delete?.(key)) throw new Error('injected delete failure')
        return super.delete(key)
    }
}

class TrackingStore extends MemoryStore {
    constructor() {
        super()
        this.listPrefixes = []
    }

    async list(options = {}) {
        this.listPrefixes.push(options.prefix || '')
        return super.list(options)
    }
}

class ReadTrackingStore extends MemoryStore {
    constructor() {
        super()
        this.enabled = false
        this.getKeys = []
        this.getOptions = []
        this.active = 0
        this.maxActive = 0
        this.listOptions = []
    }

    async get(key, options = {}) {
        if (!this.enabled) return super.get(key, options)
        this.getKeys.push(key)
        this.getOptions.push({ key, options })
        this.active += 1
        this.maxActive = Math.max(this.maxActive, this.active)
        try {
            await new Promise(resolve => setTimeout(resolve, 1))
            return await super.get(key, options)
        } finally {
            this.active -= 1
        }
    }

    async list(options = {}) {
        if (this.enabled) this.listOptions.push(options)
        return super.list(options)
    }
}

class BootstrapCommentFailureStore extends MemoryStore {
    failCommentReads = false

    async get(key, options = {}) {
        if (this.failCommentReads && key === 'meta/comments-number-hint.json') {
            throw new Error('injected bootstrap comment failure')
        }
        return super.get(key, options)
    }
}

class DelayedIndexFailureStore extends MemoryStore {
    delayedWriteFinished = false
    rollbackStartedEarly = false

    async setJSON(key, value, options = {}) {
        if (key.startsWith('indexes/comments/by-user-v2/')) {
            await new Promise(resolve => setTimeout(resolve, 20))
            await super.setJSON(key, value, options)
            this.delayedWriteFinished = true
            return
        }
        if (key.startsWith('dates/')) throw new Error('injected date failure')
        return super.setJSON(key, value, options)
    }

    async delete(key) {
        if (key.startsWith('comments/') && !this.delayedWriteFinished) {
            this.rollbackStartedEarly = true
        }
        return super.delete(key)
    }
}

class DelayedCacheWarmStore extends MemoryStore {
    constructor() {
        super()
        this.warmStarted = new Promise(resolve => {
            this.resolveWarmStarted = resolve
        })
        this.warmRelease = new Promise(resolve => {
            this.resolveWarmRelease = resolve
        })
    }

    async setJSON(key, value, options = {}) {
        if (key.startsWith('cache/comment-like-count/') && options.onlyIfNew) {
            this.resolveWarmStarted()
            await this.warmRelease
        }
        return super.setJSON(key, value, options)
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
    PUBLIC_SITE_URL: origin,
    ADMIN_BOOTSTRAP_SECRET: 'test-admin-bootstrap-secret',
    ALLOWED_ORIGINS: origin,
}

function assertIdsDescending(items) {
    for (let i = 1; i < items.length; i += 1) {
        assert.ok(items[i - 1].id >= items[i].id, '留言应按 id 降序返回')
    }
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
        for (const field of ['id', 'number', 'displayId', 'uid', 'sender', 'avatar', 'comment', 'image', 'hidden', 'likes', 'liked', 'time']) {
            assert.ok(Object.hasOwn(published.a, field), `发布响应缺少 ${field}`)
        }
        assert.equal(published.a.displayId, published.a.number)
        assert.equal(published.a.likes, 0)
        assert.equal(published.a.liked, false)
    })

    it('keeps numbers stable after deleting another comment', async () => {
        const removed = await call(state, 'POST', 'admin/comments/moderate', {
            commentId: published.b.id,
            action: 'delete',
        })
        assert.equal(removed.response.status, 200)

        const listed = await call(state, 'GET', 'comments?count=10')
        const numbers = listed.payload.data.items.map(comment => comment.displayId)
        assert.deepEqual(numbers, [3, 1])
        assert.deepEqual(listed.payload.data.items.map(comment => comment.comment), ['第三条', '第一条'])

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
        assert.deepEqual(reply.replyPreview, {
            id: published.a.id,
            number: 1,
            displayId: 1,
            sender: '编号用户',
            avatar: '',
            comment: '第一条',
        })
        published.reply = reply
        const listed = await call(state, 'GET', 'comments?count=10')
        const replyRecord = listed.payload.data.items.find(comment => comment.id === reply.id)
        assert.deepEqual(replyRecord.replyPreview, {
            id: published.a.id,
            number: 1,
            displayId: 1,
            sender: '编号用户',
            avatar: '',
            comment: '第一条',
        })
    })

    it('keeps numbers unaffected by hide and restore', async () => {
        const hidden = await call(state, 'POST', 'admin/comments/moderate', {
            commentId: published.reply.id,
            action: 'hide',
        })
        assert.equal(hidden.response.status, 200)
        const adminView = await call(state, 'GET', 'comments?count=10')
        const afterHide = adminView.payload.data.items.find(comment => comment.comment === '回复第一条')
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

    it('derives concurrent likes from authoritative like records', async () => {
        const pair = [createState('10.0.5.4'), createState('10.0.5.5')]
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        pair.forEach(state => { state.stores = stores })
        await register(pair[0], '点赞甲', 'like-a@example.com')
        await register(pair[1], '点赞乙', 'like-b@example.com')
        const comment = await postComment(pair[0], '并发点赞留言')

        const results = await Promise.all(pair.map(state =>
            call(state, 'POST', `comments/like?commentId=${comment.id}`)))
        assert.ok(results.every(result => result.payload.data.likes >= 1))
        assert.equal(Math.max(...results.map(result => result.payload.data.likes)), 2)

        const listed = await call(pair[0], 'GET', `comments?number=${comment.number}`)
        assert.equal(listed.payload.data[0].likes, 2)
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

    it('waits for sibling index writes to settle before rollback', async () => {
        const data = new DelayedIndexFailureStore()
        await assert.rejects(
            () => createComment(data, user, { comment: '延迟索引失败' }, {
                idFactory: () => 9876543210123776,
            }),
            error => error.status === 500,
        )
        assert.equal(data.rollbackStartedEarly, false)
        assert.equal(
            (await data.list({ prefix: 'indexes/comments/by-user-v2/' })).blobs.length,
            0,
        )
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

        const removed = await call(state, 'POST', 'admin/comments/moderate', {
            commentId: c2.id,
            action: 'delete',
        })
        assert.equal(removed.response.status, 200)

        // 编号占位保留并转为 tombstone:跳转空号返回 404,新留言从 4 开始
        const jump = await call(state, 'GET', 'comments?number=2')
        assert.equal(jump.response.status, 404)
        const d = await postComment(state, '丁')
        assert.equal(d.number, 4)
        const seat = await state.stores.data.get('indexes/comments/number/2.json', { type: 'json' })
        assert.equal(seat.commentId, c2.id)
        assert.equal(seat.tombstone, true)
        assert.ok(seat.deletedAt)

        // 回复 tombstone 空号 → 404
        const replyToGap = await call(state, 'POST', 'comments/post', { comment: '回复空号', replyid: 2 })
        assert.equal(replyToGap.response.status, 404)

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

describe('visible-comment pagination', () => {
    const state = createState('10.0.11.1')
    const viewer = createState('10.0.11.2')

    it('pages by visible count on the main list and user list, without duplicates', async () => {
        await register(state, '分页甲', 'page-a@example.com')
        viewer.stores = state.stores
        await register(viewer, '分页丙', 'page-c@example.com')
        const posts = []
        const realNow = Date.now
        const baseTime = realNow() - 1000
        try {
            for (let i = 1; i <= 6; i += 1) {
                Date.now = () => baseTime + i * 10
                posts.push(await postComment(state, `留言${i}`))
            }
        } finally {
            Date.now = realNow
        }
        // 隐藏第 2、4 条
        for (const id of [posts[1].id, posts[3].id]) {
            await call(state, 'POST', 'admin/comments/moderate', { commentId: id, action: 'hide' })
        }

        // 以普通用户视角分页(同一毫秒发布的留言 id 顺序不保证,按集合+降序断言)
        const newest = await call(viewer, 'GET', 'comments?count=3')
        assert.deepEqual(newest.payload.data.items.map(comment => comment.comment).sort(), ['留言3', '留言5', '留言6'])
        assertIdsDescending(newest.payload.data.items)

        const older = await call(viewer, 'GET', `comments?from=${posts[2].id - 1}&count=2`)
        assert.deepEqual(older.payload.data.map(comment => comment.comment), ['留言1'])
        const older2 = await call(viewer, 'GET', `comments?from=${posts[0].id - 1}&count=2`)
        assert.equal(older2.payload.data.length, 0, '已到最旧,无更多内容')

        const me = await call(state, 'GET', 'user/me')
        const uid = me.payload.data.id
        const firstPage = await call(viewer, 'GET', `comments?uid=${uid}&count=2`)
        assert.deepEqual(firstPage.payload.data.items.map(item => item.comment).sort(), ['留言5', '留言6'])
        assert.equal(firstPage.payload.data.hasMore, true)
        const secondPage = await call(viewer, 'GET', `comments?uid=${uid}&count=2&cursor=${firstPage.payload.data.items[firstPage.payload.data.items.length - 1].id}`)
        assert.deepEqual(secondPage.payload.data.items.map(item => item.comment).sort(), ['留言1', '留言3'])
        assert.equal(secondPage.payload.data.hasMore, false)

        // 管理员可见隐藏留言
        const adminView = await call(state, 'GET', 'comments?count=6')
        assert.equal(adminView.payload.data.items.length, 6)
    })

    it('keeps scanning past a fully-hidden first page on both lists', async () => {
        const posts = []
        for (let i = 1; i <= 4; i += 1) {
            posts.push(await postComment(state, `乙${i}`))
        }
        await call(state, 'POST', 'admin/comments/moderate', { commentId: posts[3].id, action: 'hide' })
        await call(state, 'POST', 'admin/comments/moderate', { commentId: posts[2].id, action: 'hide' })

        // 最新两页全隐藏,可见内容在更早位置:count=2 应返回后面的可见留言而非空
        const page = await call(viewer, 'GET', 'comments?count=2')
        assert.deepEqual(page.payload.data.items.map(comment => comment.comment).sort(), ['乙1', '乙2'])
        assertIdsDescending(page.payload.data.items)

        const me = await call(state, 'GET', 'user/me')
        const uid = me.payload.data.id
        // 用户列表同样越过隐藏块,并跨多页不重复、不遗漏
        const collected = []
        let cursor
        for (let round = 0; round < 10; round += 1) {
            const userPage = await call(viewer, 'GET', `comments?uid=${uid}&count=2${cursor ? `&cursor=${cursor}` : ''}`)
            collected.push(...userPage.payload.data.items.map(item => item.comment))
            if (!userPage.payload.data.hasMore) break
            cursor = userPage.payload.data.items[userPage.payload.data.items.length - 1].id
        }
        assert.deepEqual(collected.sort(), ['乙1', '乙2', '留言1', '留言3', '留言5', '留言6'])
    })
})

describe('bounded main comment reads', () => {
    it('uses stable number seats instead of listing every comment key', async () => {
        const data = new TrackingStore()
        const ids = [1752000000000001, 1752000000000002, 1752000000000003]
        for (const [index, id] of ids.entries()) {
            await createComment(data, user, { comment: `有界读取${index + 1}` }, {
                idFactory: () => id,
            })
        }
        data.listPrefixes = []
        const page = await listComments(data, new URLSearchParams({ count: '2' }), user)
        assert.deepEqual(page.items.map(comment => comment.id), ids.slice(1).reverse())
        assert.equal(data.listPrefixes.includes('comments/'), false)
        assert.equal(data.listPrefixes.some(prefix => prefix.startsWith('likes/')), false)
    })

    it('uses the isolated like-count cache without listing like records', async () => {
        const data = new MemoryStore()
        const comment = await createComment(data, user, { comment: '分页点赞计数' })
        await Promise.all(Array.from({ length: 501 }, (_, index) =>
            data.setJSON(`likes/${comment.id}/user-${index}.json`, { userId: `user-${index}` })))
        await data.setJSON(`cache/comment-like-count/${comment.id}.json`, {
            commentId: comment.id,
            count: 501,
        })

        const page = await listComments(data, new URLSearchParams({ number: String(comment.number) }), user)
        assert.equal(page[0].likes, 501)
    })

    it('never scans like facts on the list path and flags legacy comments for repair', async () => {
        const data = new TrackingStore()
        const id = 1752000000000999
        await data.setJSON(`comments/${id}.json`, {
            id,
            uid: user.id,
            sender: user.name,
            comment: '历史点赞',
            hidden: false,
            time: 1,
        })
        await data.setJSON(`likes/${id}/legacy-user.json`, { userId: 'legacy-user' })

        // 历史留言缺缓存且无 likeCountVersion=1:列表路径不得扫描点赞事实,
        // 显示 0 并写 repair marker,由维护脚本精确重建。
        const first = await listComments(data, new URLSearchParams({ from: String(id), count: '1' }), user)
        assert.equal(first.items[0].likes, 0)
        assert.equal(data.listPrefixes.some(prefix => prefix.startsWith('likes/')), false)
        const marker = await data.get(`repairs/comment-like-count/${id}.json`, { type: 'json' })
        assert.equal(marker.status, 'open')
        assert.equal(marker.commentId, id)

        data.listPrefixes = []
        const second = await listComments(data, new URLSearchParams({ from: String(id), count: '1' }), user)
        assert.equal(second.items[0].likes, 0)
        assert.equal(data.listPrefixes.some(prefix => prefix.startsWith('likes/')), false)
        const markers = await data.list({ prefix: 'repairs/comment-like-count/' })
        assert.equal(markers.blobs.length, 1, 'marker 只写一次')
    })

    it('keeps the like cache driven by like operations, not list reads', async () => {
        const data = new DelayedCacheWarmStore()
        const id = 1752000000000888
        await data.setJSON(`comments/${id}.json`, {
            id,
            uid: user.id,
            sender: user.name,
            comment: '并发升温',
            hidden: false,
            time: 1,
        })

        const listing = listComments(
            data,
            new URLSearchParams({ from: String(id), count: '1' }),
            user,
        )
        await listing
        // 列表路径不再写点赞缓存(只可能写 repair marker)
        assert.equal(
            await data.get(`cache/comment-like-count/${id}.json`, { type: 'json' }),
            null,
        )
        await setLike(data, id, user, true)
        assert.equal(
            (await data.get(`cache/comment-like-count/${id}.json`, { type: 'json' })).count,
            1,
        )
    })

    it('loads thirty recent comments in one bounded concurrent seat batch', async () => {
        const data = new ReadTrackingStore()
        const base = 1752000000000000
        for (let number = 1; number <= 80; number += 1) {
            const id = base + number
            await data.setJSON(`indexes/comments/number/${number}.json`, { commentId: id })
            await data.setJSON(`comments/${String(id).padStart(16, '0')}.json`, {
                id,
                number,
                uid: user.id,
                sender: user.name,
                avatar: '',
                comment: `批量留言${number}`,
                image: '',
                replyid: null,
                hidden: false,
                likeCount: 0,
                likeCountVersion: 1,
                createdAt: number,
                time: number,
            })
        }
        await data.setJSON('meta/comments-number-hint.json', { value: 80 })
        data.enabled = true

        const page = await listComments(data, new URLSearchParams({ count: '30' }), user)
        assert.equal(page.items.length, 30)
        assert.equal(data.getKeys.filter(key => key.startsWith('indexes/comments/number/')).length, 30)
        assert.equal(data.getKeys.filter(key => key.startsWith('comments/')).length, 30)
        assert.equal(data.listOptions.some(options => String(options.prefix).startsWith('likes/')), false)
        assert.ok(data.maxActive > 1)
        assert.ok(data.maxActive <= 8)
        assert.equal(page.hasMore, true)
        assert.equal(page.nextCursor, base + 51)

        data.getKeys = []
        const second = await listComments(data, new URLSearchParams({
            count: '30',
            cursor: String(page.nextCursor),
            direction: 'before',
        }), user)
        assert.deepEqual(
            second.items.map(comment => comment.number),
            Array.from({ length: 30 }, (_, index) => 50 - index),
        )
        assert.equal(second.hasMore, true)
        assert.equal(second.nextCursor, base + 21)

        const third = await listComments(data, new URLSearchParams({
            count: '30',
            cursor: String(second.nextCursor),
            direction: 'before',
        }), user)
        assert.deepEqual(
            third.items.map(comment => comment.number),
            Array.from({ length: 20 }, (_, index) => 20 - index),
        )
        assert.equal(third.hasMore, false)
        const allNumbers = [
            ...page.items.map(comment => comment.number),
            ...second.items.map(comment => comment.number),
            ...third.items.map(comment => comment.number),
        ]
        assert.equal(new Set(allNumbers).size, 80, '分页不得重复或遗漏')
        assert.deepEqual(allNumbers, [...allNumbers].sort((left, right) => right - left), '保持编号降序')

        const newer = await listComments(data, new URLSearchParams({
            count: '-10',
            cursor: String(base + 20),
            direction: 'after',
        }), user)
        assert.deepEqual(
            newer.items.map(comment => comment.number),
            Array.from({ length: 10 }, (_, index) => 30 - index),
        )
        assert.equal(newer.hasMore, true)
        assert.equal(newer.nextCursor, base + 30)

        const newest = await listComments(data, new URLSearchParams({
            count: '-10',
            cursor: String(base + 70),
            direction: 'after',
        }), user)
        assert.deepEqual(
            newest.items.map(comment => comment.number),
            Array.from({ length: 10 }, (_, index) => 80 - index),
        )
        assert.equal(newest.hasMore, false)
    })

    it('caps an anonymous bootstrap at 38 Blob operations for twelve comments', async () => {
        const data = new ReadTrackingStore()
        const state = createState('10.0.7.8')
        state.stores.data = data
        const base = 1754000000000000
        for (let number = 1; number <= 20; number += 1) {
            const id = base + number
            await data.setJSON(`indexes/comments/number/${number}.json`, { commentId: id })
            await data.setJSON(`comments/${String(id).padStart(16, '0')}.json`, {
                id,
                number,
                uid: user.id,
                sender: user.name,
                avatar: '',
                comment: `bootstrap-${number}`,
                image: '',
                replyid: null,
                hidden: false,
                likeCount: 0,
                likeCountVersion: 1,
                createdAt: number,
                time: number,
            })
        }
        await data.setJSON('meta/comments-number-hint.json', { value: 20 })
        data.enabled = true

        const result = await call(state, 'GET', 'bootstrap')

        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.profile, null)
        assert.equal(result.payload.data.comments.items.length, 12)
        assert.equal(data.getKeys.length, 37)
        assert.equal(data.listOptions.length, 1)
        assert.equal(data.getKeys.length + data.listOptions.length, 38)
        assert.ok(data.maxActive <= 8)
    })

    it('loads ten public comments without session reads or date listings', async () => {
        const data = new ReadTrackingStore()
        const state = createState('10.0.7.11')
        state.stores.data = data
        state.jar.set('elytrue_session', 'ignored-public-session')
        const base = 1755000000000000
        for (let number = 1; number <= 12; number += 1) {
            const id = base + number
            await data.setJSON(`indexes/comments/number/${number}.json`, { commentId: id })
            await data.setJSON(`comments/${String(id).padStart(16, '0')}.json`, {
                id,
                number,
                uid: user.id,
                sender: user.name,
                avatar: '',
                comment: `public-${number}`,
                image: '',
                replyid: null,
                hidden: false,
                likeCount: 0,
                likeCountVersion: 1,
                createdAt: number,
                time: number,
            })
        }
        await data.setJSON('meta/comments-number-hint.json', { value: 12 })
        data.enabled = true

        const result = await call(state, 'GET', 'comments/public?count=10')

        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.items.length, 10)
        assert.equal(data.getKeys.length, 31)
        assert.equal(data.listOptions.length, 0)
        assert.equal(data.getKeys.some(key => key.startsWith('sessions/')), false)
        assert.equal(data.getKeys.some(key => key.startsWith('users/')), false)
        const eventual = data.getOptions.filter(
            ({ options }) => options.consistency === 'eventual',
        )
        const strong = data.getOptions.filter(
            ({ options }) => options.consistency === 'strong',
        )
        assert.equal(eventual.length, 21)
        assert.equal(strong.length, 10)
        assert.equal(
            strong.every(({ key }) => key.startsWith('comments/')),
            true,
        )
    })

    it('keeps user/me to session, user and admin marker reads', async () => {
        const adminState = createState('10.0.7.12')
        await register(adminState, '首位用户', 'first-user@example.com')
        const state = createState('10.0.7.13')
        state.stores = adminState.stores
        await register(state, '普通用户', 'regular-user@example.com')

        const data = new ReadTrackingStore()
        for (const [key, value] of state.stores.data.values) {
            data.values.set(key, structuredClone(value))
        }
        state.stores = { ...state.stores, data }
        data.enabled = true

        const result = await call(state, 'GET', 'user/me')

        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.name, '普通用户')
        assert.equal(data.getKeys.length, 3)
        assert.equal(data.listOptions.length, 0)
        assert.equal(
            data.getKeys.some(
                key => key.startsWith('comments/') || key.startsWith('dates/'),
            ),
            false,
        )
        assert.equal(
            data.getKeys.some(key => key.startsWith('indexes/comments/')),
            false,
        )
        assert.equal(
            data.getOptions.every(
                ({ options }) => options.consistency === 'strong',
            ),
            true,
        )
        const timing = result.response.headers.get('server-timing') || ''
        for (const category of [
            'routing',
            'session',
            'user',
            'adminMarker',
            'sessionRefresh',
            'serialization',
            'total',
        ]) {
            assert.match(timing, new RegExp(`${category};dur=\\d`))
        }
    })

    it('returns an authenticated CSRF token at the bootstrap data root', async () => {
        const state = createState('10.0.7.9')
        await register(state, '启动用户', 'bootstrap@example.com')

        state.csrfToken = ''
        const result = await call(state, 'GET', 'bootstrap')

        assert.equal(result.response.status, 200)
        assert.ok(result.payload.data.csrfToken)
        assert.equal(
            result.payload.data.csrfToken,
            result.payload.data.profile.csrfToken,
        )
        assert.equal(state.csrfToken, result.payload.data.csrfToken)
    })

    it('keeps an authenticated profile when bootstrap comment reads fail', async () => {
        const state = createState('10.0.7.10')
        const data = new BootstrapCommentFailureStore()
        state.stores.data = data
        await register(state, '故障用户', 'bootstrap-failure@example.com')

        data.failCommentReads = true
        const result = await call(state, 'GET', 'bootstrap')

        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.profile.name, '故障用户')
        assert.equal(result.payload.data.comments, null)
        assert.equal(result.payload.data.commentsError, true)
        assert.equal(
            result.payload.data.csrfToken,
            result.payload.data.profile.csrfToken,
        )
    })

    it('starts an older page near its numbered cursor instead of rescanning from newest', async () => {
        const data = new ReadTrackingStore()
        const base = 1753000000000000
        for (let number = 1; number <= 300; number += 1) {
            const id = base + number
            await data.setJSON(`indexes/comments/number/${number}.json`, { commentId: id })
            await data.setJSON(`indexes/comments/by-id/${String(id).padStart(16, '0')}.json`, {
                commentId: id,
                number,
            })
            await data.setJSON(`comments/${String(id).padStart(16, '0')}.json`, {
                id,
                number,
                uid: user.id,
                sender: user.name,
                avatar: '',
                comment: `深游标${number}`,
                image: '',
                replyid: null,
                hidden: false,
                likeCount: 0,
                likeCountVersion: 1,
                createdAt: number,
                time: number,
            })
        }
        await data.setJSON('meta/comments-number-hint.json', { value: 300 })
        data.enabled = true

        const page = await listComments(data, new URLSearchParams({
            count: '2',
            cursor: String(base + 50),
            direction: 'before',
        }), user)

        assert.deepEqual(page.items.map(comment => comment.number), [49, 48])
        assert.ok(
            data.getKeys.filter(key => key.startsWith('indexes/comments/number/')).length <= 48,
        )

        data.getKeys = []
        const exhausted = await listComments(data, new URLSearchParams({
            count: '2',
            cursor: String(base + 1),
            direction: 'before',
        }), user)
        assert.deepEqual(exhausted.items, [])
        assert.equal(exhausted.hasMore, false)
        assert.equal(
            data.getKeys.filter(key => key.startsWith('indexes/comments/number/')).length,
            0,
        )
    })
})

describe('like count cache repair', () => {
    it('keeps the like fact and writes a repair marker when cache persistence fails', async () => {
        const data = new FlakyStore()
        const created = await createComment(data, user, { comment: '点赞缓存修复' })
        data.failures.setJSON = key => key === `cache/comment-like-count/${created.id}.json`

        const result = await setLike(data, created.id, user, true)
        assert.deepEqual(result, { liked: true, likes: 1 })
        assert.ok(await data.get(`likes/${created.id}/${user.id}.json`, { type: 'json' }))
        const marker = await data.get(`repairs/comment-like-count/${created.id}.json`, { type: 'json' })
        assert.equal(marker.status, 'open')
        assert.equal(marker.authoritativeLikes, 1)
    })

    it('never rewrites the comment body while updating the cache', async () => {
        const data = new MemoryStore()
        const created = await createComment(data, user, { comment: '独立点赞缓存' })
        const key = `comments/${String(created.id).padStart(16, '0')}.json`
        const before = await data.get(key, { type: 'json' })

        await setLike(data, created.id, user, true)

        assert.deepEqual(await data.get(key, { type: 'json' }), before)
        assert.equal(
            (await data.get(`cache/comment-like-count/${created.id}.json`, { type: 'json' })).count,
            1,
        )
    })
})

describe('bounded v2 user comment index', () => {
    it('reads only the requested first page of the new descending index', async () => {
        const data = new ReadTrackingStore()
        for (let index = 0; index < 40; index += 1) {
            await createComment(data, user, { comment: `用户分页${index}` })
        }
        data.enabled = true
        const first = await listComments(data, new URLSearchParams({
            uid: user.id,
            count: '20',
        }), user)
        assert.equal(first.items.length, 20)
        assert.equal(first.hasMore, true)
        const v2Lists = data.listOptions.filter(options =>
            options.prefix === `indexes/comments/by-user-v2/${user.id}/`)
        assert.equal(v2Lists.length, 1)
        assert.equal(v2Lists[0].limit, 20)
        assert.equal(v2Lists[0].paginate, false)
    })
})

describe('comment server timing', () => {
    it('returns categorized timing without sensitive values', async () => {
        const state = createState('10.0.7.9')
        const response = await call(state, 'GET', 'comments?count=1')
        const timing = response.response.headers.get('server-timing') || ''
        for (const category of [
            'auth',
            'routing',
            'index',
            'commentBodies',
            'likes',
            'replyPreviews',
            'todayCount',
            'serialization',
            'total',
        ]) {
            assert.match(timing, new RegExp(`${category};dur=\\d`))
        }
        assert.doesNotMatch(timing, /session|password|email/iu)
    })
})

describe('comment image status consistency', () => {
    const state = createState('10.0.12.1')
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nfsAAAAASUVORK5CYII='

    it('refuses to delete images whose status is missing (legacy active)', async () => {
        await register(state, '旧图用户', 'legacy-img@example.com')
        const upload = await call(state, 'POST', 'uploads/image', { image: png })
        const imageId = upload.payload.data.imageId
        // 模拟 legacy 状态:删除 status 字段
        const aliasKey = `uploads/aliases/comments/${imageId}.json`
        const alias = await state.stores.data.get(aliasKey, { type: 'json' })
        delete alias.status
        await state.stores.data.setJSON(aliasKey, alias)

        const denied = await call(state, 'DELETE', `uploads/image?imageId=${imageId}`)
        assert.equal(denied.response.status, 409)
        assert.ok(await state.stores.data.get(aliasKey, { type: 'json' }), '图片必须保留')
    })

    it('rolls back the comment and reverts activated aliases when activation fails mid-way', async () => {
        const data = new FlakyStore({})
        const firstId = '11111111-1111-4111-8111-111111111111'
        const secondId = '22222222-2222-4222-8222-222222222222'
        for (const id of [firstId, secondId]) {
            await data.setJSON(`uploads/aliases/comments/${id}.json`, {
                imageId: id,
                userId: user.id,
                blobKey: `comments/unit-user/${id}.jpg`,
                status: 'pending',
                createdAt: Date.now(),
            })
        }
        // 第二张图片激活失败
        data.failures = { setJSON: key => key === `uploads/aliases/comments/${secondId}.json` }

        await assert.rejects(
            () => createComment(data, user, {
                comment: '激活失败',
                imageKeys: [firstId, secondId],
            }, { idFactory: () => 9876543210123555 }),
            error => error.status === 500,
        )

        // 留言与索引全部回滚
        assert.equal((await data.list({ prefix: 'comments/' })).blobs.length, 0)
        assert.equal((await data.list({ prefix: 'indexes/comments/number/' })).blobs.length, 0)
        assert.equal((await data.list({ prefix: 'indexes/comments/by-user/' })).blobs.length, 0)
        // 已激活的第一张被还原为 pending,保持「被引用 ⇔ active」
        const first = await data.get(`uploads/aliases/comments/${firstId}.json`, { type: 'json' })
        assert.equal(first.status, 'pending')
        const second = await data.get(`uploads/aliases/comments/${secondId}.json`, { type: 'json' })
        assert.equal(second.status, 'pending')
    })

    it('keeps cleanup away from pending images referenced by existing comments', async () => {
        await register(state, '引用用户', 'ref-img@example.com')
        const upload = await call(state, 'POST', 'uploads/image', { image: png })
        const imageId = upload.payload.data.imageId
        const posted = await postComment(state, '引用图片', { imageKeys: [imageId] })
        assert.equal(posted.number, 1)

        // 制造异常状态:把已引用图片的别名改回 pending 且过期
        const aliasKey = `uploads/aliases/comments/${imageId}.json`
        const alias = await state.stores.data.get(aliasKey, { type: 'json' })
        alias.status = 'pending'
        alias.createdAt = Date.now() - 25 * 60 * 60 * 1000
        await state.stores.data.setJSON(aliasKey, alias)

        // 触发自动清理(下一次上传)
        await call(state, 'POST', 'uploads/image', { image: png })

        const after = await state.stores.data.get(aliasKey, { type: 'json' })
        assert.ok(after, '被留言引用的 pending 图片不得被自动清理')
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

        // 重复删除幂等成功,不重复扣减
        const again = await call(state, 'DELETE', `uploads/image?imageId=${id2}`)
        assert.equal(again.response.status, 200)
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

    it('claims concurrent deletes once and never double-decrements usage', async () => {
        resetMemoryRateLimitsForTests()
        const id = await upload()
        const before = await usageBytes()
        const results = await Promise.all([
            call(state, 'DELETE', `uploads/image?imageId=${id}`),
            call(state, 'DELETE', `uploads/image?imageId=${id}`),
        ])
        const statuses = results.map(result => result.response.status)
        assert.ok(statuses.includes(200))
        assert.ok(statuses.every(status => status === 200 || status === 409))
        assert.equal(await usageBytes(), before - Buffer.from(png, 'base64').length)
        assert.equal((await call(state, 'DELETE', `uploads/image?imageId=${id}`)).response.status, 200)
        assert.equal(await usageBytes(), before - Buffer.from(png, 'base64').length)
    })

    it('does not repeat an ambiguous usage decrement after the marker write fails', async () => {
        const id = await upload()
        const before = await usageBytes()
        const data = state.stores.data
        const flaky = new FlakyStore()
        flaky.values = data.values
        flaky.failures.setJSON = (key, _options, value) =>
            key === `operations/image-deletes/${id}.json` && value?.usageApplied === true
        state.stores.data = flaky

        const failed = await call(state, 'DELETE', `uploads/image?imageId=${id}`)
        assert.equal(failed.response.status, 500)
        const afterFirst = await usageBytes()
        assert.equal(afterFirst, before - Buffer.from(png, 'base64').length)

        flaky.failures.setJSON = null
        const retried = await call(state, 'DELETE', `uploads/image?imageId=${id}`)
        assert.equal(retried.response.status, 200)
        assert.equal(await usageBytes(), afterFirst)
        const operation = await flaky.get(`operations/image-deletes/${id}.json`, { type: 'json' })
        assert.equal(operation.phase, 'usage-repair-needed')
    })
})

describe('upload compensation operations', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nfsAAAAASUVORK5CYII='

    it('removes the uploaded Blob when alias creation fails', async () => {
        const state = createState('10.0.10.20')
        state.stores.data = new FlakyStore()
        await register(state, '补偿用户', 'compensate@example.com')
        state.stores.data.failures.setJSON = key => key.startsWith('uploads/aliases/comments/')
        const result = await call(state, 'POST', 'uploads/image', { image: png })
        assert.equal(result.response.status, 500)
        assert.equal((await state.stores.uploads.list({ prefix: 'comments/' })).blobs.length, 0)
        const operations = await state.stores.data.list({ prefix: 'operations/image-uploads/' })
        const operation = await state.stores.data.get(operations.blobs[0].key, { type: 'json' })
        assert.equal(operation.phase, 'rolled-back')
    })

    it('keeps a committed alias usable when the usage cache write fails', async () => {
        const state = createState('10.0.10.21')
        state.stores.data = new FlakyStore()
        await register(state, '用量修复用户', 'usage-repair@example.com')
        state.stores.data.failures.setJSON = key => key === 'usage/uploads.json'
        const result = await call(state, 'POST', 'uploads/image', { image: png })
        assert.equal(result.response.status, 201)
        const imageId = result.payload.data.imageId
        assert.ok(await state.stores.data.get(`uploads/aliases/comments/${imageId}.json`, { type: 'json' }))
        const operation = await state.stores.data.get(`operations/image-uploads/${imageId}.json`, { type: 'json' })
        assert.equal(operation.phase, 'usage-repair-needed')
        assert.equal(operation.usageApplied, false)
    })
})

describe('timeline time filter', () => {
    const state = createState('10.0.17.1')

    it('returns comments at or before the given unix-second time, not an empty array', async () => {
        // id ≈ createdAt*1000;time 为 Unix 秒
        const oldMs = 1750000000000
        const oldId = 1750000000000000
        const newerMs = 1750000002000
        const newerId = 1750000002000000
        for (const [id, createdAt, text] of [
            [oldId, oldMs, '时间轴旧留言'],
            [newerId, newerMs, '时间轴新留言'],
        ]) {
            await state.stores.data.setJSON(`comments/${String(id).padStart(16, '0')}.json`, {
                id,
                uid: 'timeline-user',
                sender: '时间轴用户',
                comment: text,
                image: '',
                hidden: false,
                createdAt,
                time: Math.floor(createdAt / 1000),
            })
        }

        // 边界前一秒(旧留言的秒值):旧留言应返回,新留言被排除
        const result = await call(state, 'GET', 'comments?time=1750000001&count=5')
        assert.equal(result.response.status, 200)
        assert.ok(result.payload.data.length > 0, '时间轴请求必须返回留言而非空数组')
        assert.deepEqual(result.payload.data.map(comment => comment.comment), ['时间轴旧留言'])
        assert.ok(result.payload.data.every(comment => comment.time <= 1750000001))

        // 更早的时间点返回空是正常行为(该时间之前没有留言)
        const empty = await call(state, 'GET', 'comments?time=1749999999&count=5')
        assert.equal(empty.payload.data.length, 0)
    })
})

describe('timeline time filter (integer-second boundary)', () => {
    const state = createState('10.0.23.1')
    const T = 1750001000

    it('includes the whole integer second and respects fractional boundaries', async () => {
        const entries = [
            [T * 1e6, T * 1000, '秒内ms0'],
            [T * 1e6 + 1000, T * 1000 + 1, '秒内ms1'],
            [T * 1e6 + 500000, T * 1000 + 500, '秒内ms500'],
            [T * 1e6 + 999000, T * 1000 + 999, '秒内ms999'],
            [(T + 1) * 1e6, (T + 1) * 1000, '下一秒'],
        ]
        for (const [id, createdAt, text] of entries) {
            await state.stores.data.setJSON(`comments/${String(id).padStart(16, '0')}.json`, {
                id,
                uid: 'boundary-user',
                sender: '边界用户',
                comment: text,
                image: '',
                hidden: false,
                createdAt,
                time: Math.floor(createdAt / 1000),
            })
        }

        // 整数秒 T:该秒内 ms 0..999 全部包含,下一秒不混入
        const whole = await call(state, 'GET', `comments?time=${T}&count=10`)
        assert.equal(whole.response.status, 200)
        assert.deepEqual(whole.payload.data.map(comment => comment.comment).sort(), ['秒内ms0', '秒内ms1', '秒内ms500', '秒内ms999'])
        assert.equal(whole.payload.data.some(comment => comment.comment === '下一秒'), false)

        // 小数 T+0.5:按精确毫秒上界,ms500 含、ms999 不含
        const fractional = await call(state, 'GET', `comments?time=${T + 0.5}&count=10`)
        assert.deepEqual(fractional.payload.data.map(comment => comment.comment).sort(), ['秒内ms0', '秒内ms1', '秒内ms500'])
    })
})

describe('hard-delete failure consistency and repair markers', () => {
    let setupCounter = 0
    async function setup(ip) {
        setupCounter += 1
        const state = createState(ip)
        await register(state, `删除失败用户${setupCounter}`, `del-fail-${setupCounter}@example.com`)
        const posted = await postComment(state, '待删除')
        return state
    }

    it('aborts cleanly when the tombstone write fails, leaving everything intact', async () => {
        const state = await setup('10.0.24.1')
        const posted = await call(state, 'GET', 'comments?count=5')
        const targetId = posted.payload.data.items[0].id
        const originalValues = state.stores.data.values
        state.stores.data = new FlakyStore({ setJSON: key => key.startsWith('indexes/comments/number/') })
        state.stores.data.values = originalValues
        try {
            const failed = await call(state, 'POST', 'admin/comments/moderate', {
                commentId: targetId,
                action: 'delete',
            })
            assert.equal(failed.response.status, 500)
        } finally {
            state.stores.data = Object.assign(new MemoryStore(), { values: originalValues })
        }
        // 正文、占位(未 tombstone)、用户索引全部保持原样
        const body = await state.stores.data.get(`comments/${String(targetId).padStart(16, '0')}.json`, { type: 'json' })
        assert.ok(body, '正文不得被删除')
        const seat = await state.stores.data.get('indexes/comments/number/1.json', { type: 'json' })
        assert.equal(seat.tombstone, undefined, '占位不得标记 tombstone')
        const uid = (await call(state, 'GET', 'user/me')).payload.data.id
        const byUserKey = `indexes/comments/by-user/${uid}/${String(targetId).padStart(16, '0')}.json`
        assert.ok(await state.stores.data.get(byUserKey, { type: 'json' }), '用户索引不得被删除')
        assert.equal((await state.stores.data.list({ prefix: 'repairs/' })).blobs.length, 0, '不得写 repair marker')
    })

    it('writes a repair marker when the user index delete fails', async () => {
        const state = await setup('10.0.24.2')
        const me = await call(state, 'GET', 'user/me')
        const targetId = (await call(state, 'GET', 'comments?count=5')).payload.data.items[0].id
        const originalValues = state.stores.data.values
        const uid = me.payload.data.id
        const byUserKey = `indexes/comments/by-user/${uid}/${String(targetId).padStart(16, '0')}.json`
        state.stores.data = new FlakyStore({ delete: key => key === byUserKey })
        state.stores.data.values = originalValues
        let result
        try {
            result = await call(state, 'POST', 'admin/comments/moderate', {
                commentId: targetId,
                action: 'delete',
            })
        } finally {
            state.stores.data = Object.assign(new MemoryStore(), { values: originalValues })
        }
        assert.equal(result.response.status, 200)
        // 正文已删、占位已 tombstone、残留用户索引 + marker
        assert.equal(await state.stores.data.get(`comments/${String(targetId).padStart(16, '0')}.json`, { type: 'json' }), null)
        const seat = await state.stores.data.get('indexes/comments/number/1.json', { type: 'json' })
        assert.equal(seat.tombstone, true)
        assert.ok(await state.stores.data.get(byUserKey, { type: 'json' }), '用户索引残留等待修复')
        const marker = await state.stores.data.get(`repairs/comment-delete/${targetId}.json`, { type: 'json' })
        assert.ok(marker, '必须写入 repair marker')
        assert.equal(marker.step, 'user-index')
        assert.equal(marker.status, 'open')
        // 修复:手工重试删除残留索引后清除 marker
        await state.stores.data.delete(byUserKey)
        await state.stores.data.delete(`repairs/comment-delete/${targetId}.json`)
        assert.equal((await state.stores.data.list({ prefix: 'repairs/' })).blobs.length, 0)
    })
})

describe('scanCap pagination with nextCursor', () => {
    const state = createState('10.0.25.1')
    const viewer = createState('10.0.25.2')

    it('pages past a hidden block longer than scanCap without loss or loops', async () => {
        await register(state, '深藏用户', 'deep@example.com')
        viewer.stores = state.stores
        await register(viewer, '旁观者', 'bystander@example.com')
        const ownerId = (await call(state, 'GET', 'user/me')).payload.data.id

        // 直接播种:252 条留言,其中 i=2..251 为隐藏(250 条,超过 scanCap=240),i=0,1 可见且最旧
        const baseId = 1786000000000000
        for (let i = 0; i < 252; i += 1) {
            const id = baseId + i
            const createdAt = 1786000000000 + i
            const hidden = i >= 2
            await state.stores.data.setJSON(`comments/${String(id).padStart(16, '0')}.json`, {
                id,
                uid: ownerId,
                sender: '深藏用户',
                comment: hidden ? `隐藏${i}` : `可见${i}`,
                image: '',
                hidden,
                createdAt,
                time: Math.floor(createdAt / 1000),
            })
            await state.stores.data.setJSON(`indexes/comments/by-user/${ownerId}/${String(id).padStart(16, '0')}.json`, { commentId: id, createdAt })
        }

        // 用户列表:首页 240 次扫描全部是隐藏 → items=[] 但 hasMore + nextCursor 可继续
        const page1 = await call(viewer, 'GET', `comments?uid=${ownerId}&count=2`)
        assert.equal(page1.payload.data.items.length, 0, '首页全部隐藏')
        assert.equal(page1.payload.data.hasMore, true)
        assert.ok(page1.payload.data.nextCursor, 'items 为空也必须给出 nextCursor')

        const found = []
        let cursor = page1.payload.data.nextCursor
        let rounds = 0
        for (; rounds < 10; rounds += 1) {
            const page = await call(viewer, 'GET', `comments?uid=${ownerId}&count=2&cursor=${cursor}`)
            found.push(...page.payload.data.items.map(item => item.comment))
            if (!page.payload.data.hasMore) break
            assert.ok(page.payload.data.nextCursor, 'hasMore 时必须带 nextCursor,避免死循环')
            cursor = page.payload.data.nextCursor
        }
        assert.ok(rounds < 10, '必须终止,不得死循环')
        assert.deepEqual(found.sort(), ['可见0', '可见1'], '不重复、不遗漏')

        // 主列表:可见内容在 cap 之外,返回 { items:[], hasMore:true },不得误判到底
        const main = await call(viewer, 'GET', 'comments?count=2')
        assert.equal(Array.isArray(main.payload.data), false, '截断时返回对象形态')
        assert.equal(main.payload.data.hasMore, true, '不得误判到底')
        assert.equal(main.payload.data.items.length, 0, 'cap 内全部隐藏')
    })
})
