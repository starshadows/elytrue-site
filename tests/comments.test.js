import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handleApiRequest } from '../server/app.js'
import { blobKeys } from '../server/domain/blob-keys.js'
import { MemoryStore } from '../server/storage.js'
import {
    createComment,
    getCommentVisibility,
    getViewerLikeStates,
    listComments,
    moderateComment,
    setLike,
    shanghaiDateString,
} from '../server/comments.js'
import { resetMemoryRateLimitsForTests } from '../server/rate-limit.js'
import {
    LATEST_COMMENT_SCAN_LIMIT,
    refreshLatestCommentView,
} from '../server/services/comment-view-service.js'

const origin = 'https://preview.elytrue.test'
const env = {
    ELYTRUE_APP_SECRET: 'test-only-secret-that-is-longer-than-thirty-two-characters',
    PUBLIC_SITE_URL: origin,
    ADMIN_BOOTSTRAP_SECRET: 'test-admin-bootstrap-secret',
    ALLOWED_ORIGINS: origin,
}
const user = { id: 'unit-user', name: '单元用户', avatarKey: '' }

class InstrumentedStore extends MemoryStore {
    constructor() {
        super()
        this.enabled = false
        this.getKeys = []
        this.listOptions = []
        this.activeReads = 0
        this.maxActiveReads = 0
    }

    resetReads() {
        this.getKeys = []
        this.listOptions = []
        this.activeReads = 0
        this.maxActiveReads = 0
    }

    async get(key, options = {}) {
        if (!this.enabled) return super.get(key, options)
        this.getKeys.push(key)
        this.activeReads += 1
        this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads)
        try {
            await new Promise(resolve => setTimeout(resolve, 1))
            return await super.get(key, options)
        } finally {
            this.activeReads -= 1
        }
    }

    async list(options = {}) {
        if (!this.enabled) return super.list(options)
        this.listOptions.push(options)
        this.activeReads += 1
        this.maxActiveReads = Math.max(this.maxActiveReads, this.activeReads)
        try {
            await new Promise(resolve => setTimeout(resolve, 1))
            return await super.list(options)
        } finally {
            this.activeReads -= 1
        }
    }
}

class FlakyStore extends MemoryStore {
    constructor() {
        super()
        this.failSet = () => false
        this.failGet = () => false
        this.failList = () => false
        this.failDelete = () => false
    }

    async setJSON(key, value, options = {}) {
        if (this.failSet(key, value, options)) throw new Error('injected set failure')
        return super.setJSON(key, value, options)
    }

    async get(key, options = {}) {
        if (this.failGet(key, options)) throw new Error('injected get failure')
        return super.get(key, options)
    }

    async list(options = {}) {
        if (this.failList(options)) throw new Error('injected list failure')
        return super.list(options)
    }

    async delete(key) {
        if (this.failDelete(key)) throw new Error('injected delete failure')
        return super.delete(key)
    }
}

class PausedLikeStore extends MemoryStore {
    constructor() {
        super()
        this.pausedCommentId = null
        this.likeWriteStarted = Promise.resolve()
        this.releaseLikeWrite = () => {}
    }

    pauseLikeWrite(commentId) {
        this.pausedCommentId = commentId
        this.likeWriteStarted = new Promise(resolve => {
            this.markLikeWriteStarted = resolve
        })
        this.likeWriteRelease = new Promise(resolve => {
            this.releaseLikeWrite = resolve
        })
    }

    async setJSON(key, value, options = {}) {
        if (
            this.pausedCommentId
            && key === blobKeys.comment(this.pausedCommentId)
            && value?.likes === 1
            && value?.version === 2
        ) {
            this.pausedCommentId = null
            this.markLikeWriteStarted()
            await this.likeWriteRelease
        }
        return super.setJSON(key, value, options)
    }
}

class PausedModerationStore extends MemoryStore {
    pauseBeforePublicHide(commentId) {
        this.pausedCommentId = commentId
        this.publicHideStarted = new Promise(resolve => {
            this.markPublicHideStarted = resolve
        })
        this.publicHideRelease = new Promise(resolve => {
            this.releasePublicHide = resolve
        })
    }

    async setJSON(key, value, options = {}) {
        if (
            this.pausedCommentId
            && key === blobKeys.commentPublicView(this.pausedCommentId)
            && value?.hidden === true
        ) {
            this.pausedCommentId = null
            this.markPublicHideStarted()
            await this.publicHideRelease
        }
        return super.setJSON(key, value, options)
    }
}

class PausedCreateStore extends MemoryStore {
    constructor() {
        super()
        this.createWriteStarted = new Promise(resolve => {
            this.markCreateWriteStarted = resolve
        })
        this.createWriteRelease = new Promise(resolve => {
            this.releaseCreateWrite = resolve
        })
        this.pauseCreateWrite = true
    }

    async setJSON(key, value, options = {}) {
        if (
            this.pauseCreateWrite
            && key === blobKeys.comment(value?.id)
            && Number(value?.number) > 0
        ) {
            this.pauseCreateWrite = false
            this.markCreateWriteStarted()
            await this.createWriteRelease
        }
        return super.setJSON(key, value, options)
    }
}

function createState(ip = '127.0.0.1', data = new MemoryStore()) {
    return {
        ip,
        jar: new Map(),
        csrfToken: '',
        stores: { data, uploads: new MemoryStore() },
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
        headers.set('Cookie', [...state.jar]
            .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
            .join('; '))
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && state.csrfToken) {
        headers.set('X-CSRF-Token', state.csrfToken)
    }
    let requestBody
    if (body !== undefined) {
        headers.set('Content-Type', 'application/json')
        requestBody = JSON.stringify(body)
    }
    const response = await handleApiRequest({
        request: new Request(`${origin}/api/${path}`, { method, headers, body: requestBody }),
        env,
        clientIp: state.ip,
    }, state.stores)
    updateCookies(state.jar, response)
    const payload = response.headers.get('content-type')?.includes('application/json')
        ? await response.json()
        : null
    if (typeof payload?.data?.csrfToken === 'string') state.csrfToken = payload.data.csrfToken
    return { response, payload }
}

async function register(state, name = '测试用户', email = 'user@example.com') {
    resetMemoryRateLimitsForTests()
    const result = await call(state, 'POST', 'user/register', {
        name,
        email,
        password: 'a-secure-password',
    })
    assert.equal(result.response.status, 201)
    return result.payload.data
}

async function post(state, comment, extra = {}, headers = {}) {
    const result = await call(state, 'POST', 'comments/post', { comment, ...extra }, { headers })
    assert.equal(result.response.status, 201)
    return result.payload.data
}

async function seed(data, count, owner = user, start = 1752000000000000) {
    const comments = []
    for (let index = 1; index <= count; index += 1) {
        comments.push(await createComment(data, owner, { comment: `留言${index}` }, {
            idFactory: () => start + index,
        }))
    }
    return comments
}

describe('comment read-model functionality', () => {
    it('creates complete canonical, number, public, user and latest records', async () => {
        const data = new MemoryStore()
        const created = await createComment(data, user, { comment: '第一条' }, {
            idFactory: () => 1752000000000001,
        })
        assert.equal(created.number, 1)
        assert.equal(created.displayId, 1)
        assert.equal(created.likes, 0)
        for (const field of [
            'id', 'number', 'uid', 'sender', 'avatar', 'comment', 'image',
            'time', 'hidden', 'likes',
        ]) assert.ok(Object.hasOwn(created, field), field)

        const canonical = await data.get(blobKeys.comment(created.id), { type: 'json' })
        const seat = await data.get(blobKeys.commentNumber(1), { type: 'json' })
        const publicView = await data.get(blobKeys.commentPublicView(created.id), { type: 'json' })
        const userView = await data.get(blobKeys.commentByUser(user.id, created.id), { type: 'json' })
        const latest = await data.get(blobKeys.commentsLatestView, { type: 'json' })
        assert.equal(canonical.likes, 0)
        assert.equal(seat.commentId, created.id)
        const { visibleSinceRevision, ...createdCard } = created
        assert.deepEqual(publicView, createdCard)
        assert.deepEqual(userView, createdCard)
        assert.equal(latest.items[0].id, created.id)
        assert.equal(latest.todayCount, 1)
        assert.equal(visibleSinceRevision, latest.snapshotRevision)
        const revision = await data.get(
            blobKeys.commentsLatestRevision,
            { type: 'json' },
        )
        assert.equal(revision.revision, latest.snapshotRevision)
        const daily = await data.get(
            blobKeys.commentsDailyCount(shanghaiDateString(created.createdAt)),
            { type: 'json' },
        )
        assert.equal(daily.count, 1)
    })

    it('assigns distinct public numbers to concurrent creates', async () => {
        const data = new MemoryStore()
        const ids = [1752000000000101, 1752000000000102]
        const created = await Promise.all(ids.map((id, index) => createComment(
            data,
            { ...user, id: `u${index}` },
            { comment: `并发${index}` },
            { idFactory: () => id },
        )))
        assert.equal(new Set(created.map(comment => comment.number)).size, 2)
        assert.deepEqual(created.map(comment => comment.number).sort((a, b) => a - b), [1, 2])
        const latest = await data.get(blobKeys.commentsLatestView, { type: 'json' })
        assert.equal(latest.todayCount, 2)
    })

    it('uses a causal revision when a newer wall-clock snapshot predates publication', async () => {
        const data = new PausedCreateStore()
        const creating = createComment(data, user, { comment: '因果顺序' }, {
            idFactory: () => 1752000000000199,
        })
        await data.createWriteStarted

        const intermediate = await refreshLatestCommentView(
            data,
            shanghaiDateString(Date.now()),
        )
        data.releaseCreateWrite()
        const created = await creating
        const final = await data.get(blobKeys.commentsLatestView, { type: 'json' })

        assert.ok(intermediate.generatedAt >= created.createdAt)
        assert.equal(intermediate.items.some(item => item.id === created.id), false)
        assert.ok(intermediate.snapshotRevision < created.visibleSinceRevision)
        assert.equal(final.snapshotRevision, created.visibleSinceRevision)
        assert.equal(final.items.some(item => item.id === created.id), true)
    })

    it('keeps reply previews as publish-time snapshots after target deletion', async () => {
        const data = new MemoryStore()
        const target = await createComment(data, user, { comment: '原留言' })
        const reply = await createComment(data, user, {
            comment: '回复内容',
            replyid: target.number,
        })
        await moderateComment(data, target.id, 'delete')
        const page = await listComments(data, new URLSearchParams({ count: '10' }), null, {
            publicRead: true,
        })
        assert.equal(page.items.length, 1)
        assert.equal(page.items[0].id, reply.id)
        assert.equal(page.items[0].replyPreview.comment, '原留言')
        assert.equal(page.items[0].replyPreview.deleted, undefined)
    })

    it('updates canonical and read views for like and unlike without list-time fact scans', async () => {
        const data = new MemoryStore()
        const created = await createComment(data, user, { comment: '点赞留言' })
        assert.deepEqual(await setLike(data, created.id, user, true), { liked: true, likes: 1 })
        assert.deepEqual(await setLike(data, created.id, user, true), { liked: true, likes: 1 })
        assert.equal((await data.get(blobKeys.comment(created.id), { type: 'json' })).likes, 1)
        assert.equal((await data.get(blobKeys.commentPublicView(created.id), { type: 'json' })).likes, 1)
        assert.equal((await data.get(blobKeys.commentsLatestView, { type: 'json' })).items[0].likes, 1)
        assert.deepEqual(await setLike(data, created.id, user, false), { liked: false, likes: 0 })
        assert.equal((await data.get(blobKeys.comment(created.id), { type: 'json' })).likes, 0)
    })

    it('patches latest likes without public-view or date-fact scans', async () => {
        const data = new InstrumentedStore()
        const comments = await seed(data, 20)
        data.resetReads()
        data.enabled = true

        await setLike(data, comments.at(-1).id, user, true)

        assert.equal(
            data.listOptions.some(options =>
                options.prefix === blobKeys.commentPublicViewsPrefix),
            false,
        )
        assert.equal(
            data.listOptions.some(options => String(options.prefix).startsWith('dates/')),
            false,
        )
        const latest = await data.get(blobKeys.commentsLatestView, { type: 'json' })
        assert.equal(latest.todayCount, 20)
        assert.equal(latest.items[0].likes, 1)
    })

    it('removes hidden and deleted comments from public views while retaining number gaps', async () => {
        const data = new MemoryStore()
        const [first, second, third] = await seed(data, 3)
        await moderateComment(data, second.id, 'hide')
        let page = await listComments(data, new URLSearchParams({ count: '10' }), null, {
            publicRead: true,
        })
        assert.deepEqual(page.items.map(comment => comment.id), [third.id, first.id])
        assert.equal(await data.get(blobKeys.commentPublicView(second.id), { type: 'json' }), null)

        await moderateComment(data, second.id, 'restore')
        page = await listComments(data, new URLSearchParams({ count: '10' }), null, {
            publicRead: true,
        })
        assert.deepEqual(page.items.map(comment => comment.id), [third.id, second.id, first.id])

        await moderateComment(data, second.id, 'delete')
        const seat = await data.get(blobKeys.commentNumber(second.number), { type: 'json' })
        assert.equal(seat.tombstone, true)
        assert.equal(await data.get(blobKeys.comment(second.id), { type: 'json' }), null)
        await assert.rejects(
            () => listComments(data, new URLSearchParams({ number: String(second.number) }), null),
            error => error.status === 404,
        )
    })

    it('publishes a conservative guard before a destructive view mutation', async () => {
        const data = new PausedModerationStore()
        const [first, target, latest] = await seed(data, 3)
        data.pauseBeforePublicHide(target.id)

        const hiding = moderateComment(data, target.id, 'hide')
        await data.publicHideStarted

        for (const key of [blobKeys.commentsLatestView, blobKeys.commentsPreviousLatestView]) {
            const snapshot = await data.get(key, { type: 'json' })
            assert.ok(snapshot)
            assert.deepEqual(snapshot.items.map(item => item.id), [latest.id, first.id])
        }

        data.releasePublicHide()
        await hiding
    })

    it('keeps admin hidden-comment visibility through the dedicated hidden view', async () => {
        const data = new MemoryStore()
        const created = await createComment(data, user, { comment: '管理员可见' })
        await moderateComment(data, created.id, 'hide')
        const guest = await listComments(data, new URLSearchParams({ count: '10' }), null)
        const admin = await listComments(data, new URLSearchParams({ count: '10' }), {
            id: 'admin', role: 'admin',
        })
        assert.deepEqual(guest.items, [])
        assert.equal(admin.items[0].id, created.id)
        assert.equal(admin.items[0].hidden, true)
    })

    it('supports stable public and user pagination plus timeline boundaries', async () => {
        const data = new MemoryStore()
        const realNow = Date.now
        const base = 1760000000000
        const created = []
        try {
            for (let index = 0; index < 5; index += 1) {
                Date.now = () => base + index * 1000
                created.push(await createComment(data, user, { comment: `时间${index}` }, {
                    idFactory: () => (base + index * 1000) * 1000 + index,
                }))
            }
        } finally {
            Date.now = realNow
        }

        const first = await listComments(data, new URLSearchParams({ count: '2' }), null)
        const second = await listComments(data, new URLSearchParams({
            count: '2', cursor: String(first.nextCursor), direction: 'before',
        }), null)
        assert.deepEqual(first.items.map(item => item.id), created.slice(3).reverse().map(item => item.id))
        assert.deepEqual(second.items.map(item => item.id), created.slice(1, 3).reverse().map(item => item.id))

        const userFirst = await listComments(data, new URLSearchParams({
            uid: user.id, count: '3',
        }), null)
        const userSecond = await listComments(data, new URLSearchParams({
            uid: user.id, count: '3', cursor: String(userFirst.nextCursor),
        }), null)
        assert.equal(userFirst.items.length, 3)
        assert.equal(userSecond.items.length, 2)
        assert.equal(new Set([...userFirst.items, ...userSecond.items].map(item => item.id)).size, 5)

        const timeline = await listComments(data, new URLSearchParams({
            count: '5', time: String((base + 2500) / 1000),
        }), null)
        assert.deepEqual(timeline.items.map(item => item.comment), ['时间2', '时间1', '时间0'])

        const newer = await listComments(data, new URLSearchParams({
            count: '-2', cursor: String(created[0].id), direction: 'after',
        }), null)
        assert.deepEqual(newer.items.map(item => item.id), [created[2].id, created[1].id])
        assert.equal(newer.hasMore, true)
    })

    it('serializes like and moderation mutations without resurrecting a public card', async () => {
        const data = new PausedLikeStore()
        const created = await createComment(data, user, { comment: '并发状态' })
        data.pauseLikeWrite(created.id)
        const liking = setLike(data, created.id, user, true)
        await data.likeWriteStarted
        const hiding = moderateComment(data, created.id, 'hide')
        data.releaseLikeWrite()
        await Promise.all([liking, hiding])

        const canonical = await data.get(blobKeys.comment(created.id), { type: 'json' })
        assert.equal(canonical.hidden, true)
        assert.equal(canonical.likes, 1)
        assert.equal(canonical.version, 3)
        assert.equal(await data.get(blobKeys.commentPublicView(created.id), { type: 'json' }), null)
        assert.ok(await data.get(blobKeys.commentHiddenView(created.id), { type: 'json' }))
    })

    it('uses bounded empty user pages instead of scanning indefinitely', async () => {
        const data = new MemoryStore()
        const created = await seed(data, 4)
        await moderateComment(data, created[3].id, 'hide')
        await moderateComment(data, created[2].id, 'hide')
        const first = await listComments(data, new URLSearchParams({
            uid: user.id, count: '2',
        }), null)
        assert.deepEqual(first.items, [])
        assert.equal(first.hasMore, true)
        assert.ok(first.nextCursor)
        const second = await listComments(data, new URLSearchParams({
            uid: user.id, count: '2', cursor: String(first.nextCursor),
        }), null)
        assert.deepEqual(second.items.map(item => item.id), [created[1].id, created[0].id])
        assert.equal(second.hasMore, false)
    })

    it('makes idempotent creates retryable and rejects key reuse with another body', async () => {
        const data = new MemoryStore()
        const options = { operationId: 'create-retry-1', idFactory: () => 1752000000000999 }
        const first = await createComment(data, user, { comment: '只发布一次' }, options)
        const retried = await createComment(data, user, { comment: '只发布一次' }, options)
        assert.deepEqual(retried, first)
        assert.equal((await data.list({ prefix: 'comments/' })).blobs.length, 1)
        await assert.rejects(
            () => createComment(data, user, { comment: '不同内容' }, options),
            error => error.status === 409,
        )
    })

    it('rolls back canonical and number seat when publication cannot complete', async () => {
        const data = new FlakyStore()
        const id = 1752000000000888
        data.failSet = (key, value) => key === blobKeys.comment(id) && value.number > 0
        await assert.rejects(
            () => createComment(data, user, { comment: '发布失败' }, { idFactory: () => id }),
            error => error.status === 500,
        )
        assert.equal(await data.get(blobKeys.comment(id), { type: 'json' }), null)
        assert.equal((await data.list({ prefix: 'indexes/comments/number/' })).blobs.length, 0)
    })
})

describe('comment read operation budgets', () => {
    it('serves a normal public first page from one latest-view get', async () => {
        const data = new InstrumentedStore()
        await seed(data, 12)
        const latest = await data.get(blobKeys.commentsLatestView, { type: 'json' })
        data.enabled = true
        const page = await listComments(data, new URLSearchParams({ count: '10' }), null, {
            publicRead: true,
        })
        assert.equal(page.items.length, 10)
        assert.equal(page.snapshotGeneratedAt, latest.generatedAt)
        assert.equal(page.snapshotRevision, latest.snapshotRevision)
        assert.equal(data.getKeys.length, 1)
        assert.equal(data.listOptions.length, 0)
        assert.ok(data.getKeys.length + data.listOptions.length <= 2)
    })

    it('serves bootstrap comments and today count from one latest-view get', async () => {
        const data = new InstrumentedStore()
        await seed(data, 12)
        const state = createState('10.0.7.8', data)
        data.enabled = true
        const result = await call(state, 'GET', 'bootstrap')
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.comments.items.length, 12)
        assert.equal(result.payload.data.todayCount, 12)
        assert.ok(Number.isFinite(result.payload.data.comments.snapshotGeneratedAt))
        assert.ok(Number.isSafeInteger(result.payload.data.comments.snapshotRevision))
        assert.ok(data.getKeys.length + data.listOptions.length <= 2)
    })

    it('returns latest snapshot freshness from the public first-page API', async () => {
        const data = new MemoryStore()
        await seed(data, 2)
        const latest = await data.get(blobKeys.commentsLatestView, { type: 'json' })
        const result = await call(createState('10.0.7.12', data), 'GET', 'comments/public?count=10')
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.snapshotGeneratedAt, latest.generatedAt)
        assert.equal(result.payload.data.snapshotRevision, latest.snapshotRevision)
    })

    it('uses the previous snapshot before the bounded bootstrap fallback', async () => {
        const data = new InstrumentedStore()
        await seed(data, 15)
        await data.delete(blobKeys.commentsLatestView)
        const state = createState('10.0.7.9', data)
        data.enabled = true
        const result = await call(state, 'GET', 'bootstrap')
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.comments.items.length, 12)
        assert.equal(result.payload.data.todayCount, 14)
        assert.deepEqual(data.getKeys, [
            blobKeys.commentsLatestView,
            blobKeys.commentsPreviousLatestView,
        ])
        assert.equal(data.listOptions.length, 0)
    })

    it('falls back from two missing or corrupt snapshots with one bounded list', async () => {
        for (const corrupt of [false, true]) {
            const data = new InstrumentedStore()
            await seed(data, 15)
            for (const key of [blobKeys.commentsLatestView, blobKeys.commentsPreviousLatestView]) {
                if (corrupt) await data.setJSON(key, { version: 1, items: 'bad' })
                else await data.delete(key)
            }
            data.enabled = true
            const page = await listComments(data, new URLSearchParams({ count: '10' }), null, {
                publicRead: true,
            })
            assert.equal(page.items.length, 10)
            assert.equal(data.listOptions.length, 1)
            assert.equal(data.listOptions[0].limit, LATEST_COMMENT_SCAN_LIMIT)
            assert.equal(data.listOptions[0].paginate, false)
            assert.equal(data.getKeys.filter(key => key.startsWith('views/comments/public/')).length, 15)
            assert.ok(data.maxActiveReads > 1)
            assert.ok(data.maxActiveReads <= 8)
        }
    })

    it('uses a structurally valid snapshot from a previous Shanghai date', async () => {
        const data = new InstrumentedStore()
        await seed(data, 3)
        const latest = await data.get(blobKeys.commentsLatestView, { type: 'json' })
        latest.date = '2000-01-01'
        await data.setJSON(blobKeys.commentsLatestView, latest)
        data.enabled = true
        const page = await listComments(data, new URLSearchParams({ count: '3' }), null, {
            publicRead: true,
        })
        assert.equal(page.items.length, 3)
        assert.equal(data.listOptions.length, 0)
        assert.deepEqual(data.getKeys, [blobKeys.commentsLatestView])

        data.resetReads()
        const state = createState('10.0.7.10', data)
        const result = await call(state, 'GET', 'bootstrap')
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.comments.items.length, 3)
        assert.equal(result.payload.data.todayCount, 3)
        assert.equal(data.listOptions.length, 0)
        assert.equal(
            data.listOptions.filter(
                options => options.prefix === blobKeys.commentPublicViewsPrefix,
            ).length,
            0,
        )
        assert.equal(
            data.getKeys.filter(key => key.startsWith('views/comments/public/')).length,
            0,
        )
    })

    it('loads a user first page with one list and at most one get per item', async () => {
        const data = new InstrumentedStore()
        await seed(data, 25)
        data.enabled = true
        const page = await listComments(data, new URLSearchParams({
            uid: user.id, count: '20',
        }), null)
        assert.equal(page.items.length, 20)
        assert.equal(data.listOptions.length, 1)
        assert.equal(data.getKeys.length, 20)
        assert.equal(data.getKeys.some(key => key.startsWith('comments/')), false)
        assert.ok(data.maxActiveReads <= 8)
    })

    it('does not read like facts or reply targets on ordinary public lists', async () => {
        const data = new InstrumentedStore()
        const targets = await seed(data, 10)
        for (let index = 0; index < 10; index += 1) {
            await createComment(data, user, {
                comment: `回复${index}`,
                replyid: targets[index].number,
            })
        }
        await data.delete(blobKeys.commentsLatestView)
        await data.delete(blobKeys.commentsPreviousLatestView)
        data.enabled = true
        const page = await listComments(data, new URLSearchParams({ count: '10' }), null, {
            publicRead: true,
        })
        assert.equal(page.items.length, 10)
        assert.ok(page.items.every(item => item.replyPreview))
        assert.equal(data.getKeys.some(key => key.startsWith('likes/')), false)
        assert.equal(data.getKeys.some(key => key.startsWith('comments/')), false)
        assert.equal(data.getKeys.filter(key => key.startsWith('views/comments/public/')).length, 20)
    })

    it('batch reads viewer like states concurrently with a fixed limit', async () => {
        const data = new InstrumentedStore()
        const comments = await seed(data, 12)
        data.enabled = true
        const states = await getViewerLikeStates(data, comments.map(comment => comment.id), user)
        assert.equal(states.length, 12)
        assert.equal(data.getKeys.length, 12)
        assert.ok(data.maxActiveReads > 1)
        assert.ok(data.maxActiveReads <= 8)
    })
})

describe('comment read-model repair behavior', () => {
    it('keeps a published comment and writes a marker when latest persistence fails', async () => {
        const data = new FlakyStore()
        data.failSet = key => key === blobKeys.commentsLatestView
        const created = await createComment(data, user, { comment: '快照失败仍发布' })
        assert.ok(await data.get(blobKeys.comment(created.id), { type: 'json' }))
        assert.ok(await data.get(blobKeys.commentPublicView(created.id), { type: 'json' }))
        const marker = await data.get(blobKeys.commentViewRepair(created.id), { type: 'json' })
        assert.equal(marker.status, 'open')
        assert.equal(marker.reason, 'latest-view')
        const fallback = await listComments(data, new URLSearchParams({ count: '10' }), null, {
            publicRead: true,
        })
        assert.equal(fallback.items[0].id, created.id)
    })

    it('keeps authoritative like facts and marks failed read-view updates', async () => {
        const data = new FlakyStore()
        const created = await createComment(data, user, { comment: '点赞视图失败' })
        data.failSet = key => key === blobKeys.commentPublicView(created.id)
        const result = await setLike(data, created.id, user, true)
        assert.deepEqual(result, { liked: true, likes: 1 })
        assert.ok(await data.get(blobKeys.commentLike(created.id, user.id), { type: 'json' }))
        const marker = await data.get(blobKeys.commentViewRepair(created.id), { type: 'json' })
        assert.equal(marker.reason, 'like')
        assert.equal(marker.authoritativeLikes, 1)
    })

    it('returns a moderation error until failed public-view cleanup can be retried', async () => {
        const data = new FlakyStore()
        const created = await createComment(data, user, { comment: '删除重试' })
        data.failDelete = key => key === blobKeys.commentPublicView(created.id)
        await assert.rejects(
            () => moderateComment(data, created.id, 'delete'),
            error => error.status === 500,
        )
        assert.ok(await data.get(blobKeys.comment(created.id), { type: 'json' })
            || await data.get(blobKeys.commentViewRepair(created.id), { type: 'json' }))

        data.failDelete = () => false
        await moderateComment(data, created.id, 'delete')
        assert.equal(await data.get(blobKeys.comment(created.id), { type: 'json' }), null)
        assert.equal(await data.get(blobKeys.commentPublicView(created.id), { type: 'json' }), null)
    })

    it('keeps bootstrap profile and count when comment views fail', async () => {
        const data = new FlakyStore()
        const state = createState('10.0.7.10', data)
        await register(state, '故障用户', 'bootstrap-failure@example.com')
        data.failGet = key => key === blobKeys.commentsLatestView
        data.failList = options => options.prefix === blobKeys.commentPublicViewsPrefix
        const result = await call(state, 'GET', 'bootstrap')
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.profile.name, '故障用户')
        assert.equal(result.payload.data.comments, null)
        assert.equal(result.payload.data.commentsError, true)
        assert.equal(result.payload.data.todayCount, 0)
    })

    it('returns readable Server-Timing categories', async () => {
        const state = createState('10.0.7.11')
        const result = await call(state, 'GET', 'comments/public?count=10')
        assert.equal(result.payload.data.todayCount, 0)
        assert.equal(
            result.response.headers.get('cache-control'),
            'public, max-age=0, s-maxage=10, stale-while-revalidate=30',
        )
        const timing = result.response.headers.get('server-timing') || ''
        for (const category of [
            'routing', 'index', 'readView', 'latestView', 'previousView',
            'latestLock', 'commentBodies', 'likes', 'todayCount',
            'serialization', 'total',
        ]) assert.match(timing, new RegExp(`${category};dur=\\d`))
    })
})

describe('comment HTTP contracts', () => {
    it('supports create, jump, report, hide and hard delete', async () => {
        const admin = createState('10.0.20.1')
        const adminProfile = await register(admin, '管理员', 'admin@example.com')
        const first = await post(admin, 'HTTP 第一条')
        const jump = await call(admin, 'GET', `comments?number=${first.number}`)
        assert.equal(jump.payload.data[0].id, first.id)

        const member = createState('10.0.20.2')
        member.stores = admin.stores
        const memberProfile = await register(member, '举报用户', 'report@example.com')
        assert.notEqual(memberProfile.id, adminProfile.id)
        const report = await call(member, 'POST', 'comments/report', {
            commentId: first.id,
            reason: '测试举报',
        })
        assert.equal(report.response.status, 200)

        const hidden = await call(admin, 'POST', 'admin/comments/moderate', {
            commentId: first.id,
            action: 'hide',
        })
        assert.equal(hidden.response.status, 200)
        const publicPage = await call(member, 'GET', 'comments/public?count=10')
        assert.equal(publicPage.payload.data.items.some(item => item.id === first.id), false)

        const deleted = await call(admin, 'POST', 'admin/comments/moderate', {
            commentId: first.id,
            action: 'delete',
        })
        assert.equal(deleted.response.status, 200)
        const reports = await call(admin, 'GET', 'admin/reports')
        assert.equal(reports.payload.data[0].displayId, first.number)
        assert.equal(reports.payload.data[0].deleted, true)
    })

    it('uses X-Idempotency-Key without changing the response contract', async () => {
        const state = createState('10.0.21.1')
        await register(state, '重试用户', 'retry@example.com')
        const headers = { 'X-Idempotency-Key': 'request-1' }
        const first = await post(state, '网络重试', {}, headers)
        const second = await post(state, '网络重试', {}, headers)
        assert.deepEqual(second, first)
    })

    it('counts publications by Shanghai natural day', async () => {
        const state = createState('10.0.22.1')
        await register(state, '计数用户', 'count@example.com')
        await post(state, '今天一')
        await post(state, '今天二')
        const date = shanghaiDateString(Date.now())
        const count = await call(state, 'GET', `comments/count?date=${date}`)
        assert.equal(count.payload.data, 2)
        assert.equal(shanghaiDateString(new Date('2026-08-01T16:30:00Z').getTime()), '2026-08-02')
    })
})

describe('strong comment visibility verification', () => {
    it('is fail-safe for missing, hidden, deleting, and inconsistent read models', async () => {
        const data = new FlakyStore()
        const created = await createComment(data, user, {
            comment: '可见性验证',
            imageKeys: [],
        })
        const id = created.id

        assert.deepEqual(await getCommentVisibility(data, [id, id + 1]), [
            { id, state: 'visible' },
            { id: id + 1, state: 'not_visible' },
        ])

        await data.delete(blobKeys.commentPublicView(id))
        assert.deepEqual(await getCommentVisibility(data, [id]), [
            { id, state: 'indeterminate' },
        ])

        await data.setJSON(blobKeys.commentPublicView(id), { broken: true })
        assert.equal((await getCommentVisibility(data, [id]))[0].state, 'indeterminate')

        await data.setJSON(blobKeys.commentPublicView(id), {
            ...created,
            comment: 'stale read model',
        })
        assert.equal((await getCommentVisibility(data, [id]))[0].state, 'indeterminate')

        const canonical = await data.get(blobKeys.comment(id), { type: 'json' })
        await data.setJSON(blobKeys.comment(id), { ...canonical, sender: null })
        assert.equal((await getCommentVisibility(data, [id]))[0].state, 'indeterminate')

        await data.setJSON(blobKeys.comment(id), { ...canonical, hidden: true })
        assert.equal((await getCommentVisibility(data, [id]))[0].state, 'not_visible')

        await data.setJSON(blobKeys.comment(id), {
            ...canonical,
            hidden: false,
            deleting: true,
        })
        assert.equal((await getCommentVisibility(data, [id]))[0].state, 'not_visible')

        await data.setJSON(blobKeys.comment(id), canonical)
        data.failGet = key => key === blobKeys.comment(id)
        assert.equal((await getCommentVisibility(data, [id]))[0].state, 'indeterminate')
    })

    it('validates the public batch contract and never caches verification', async () => {
        const state = createState('10.0.23.1')
        const invalid = await call(state, 'GET', 'comments/visibility?ids=1,nope')
        assert.equal(invalid.response.status, 400)

        const tooMany = await call(
            state,
            'GET',
            `comments/visibility?ids=${Array.from({ length: 11 }, (_, index) => index + 1).join(',')}`,
        )
        assert.equal(tooMany.response.status, 400)

        const valid = await call(state, 'GET', 'comments/visibility?ids=1,1')
        assert.equal(valid.response.status, 200)
        assert.equal(valid.response.headers.get('cache-control'), 'no-store')
        assert.deepEqual(valid.payload.data, [{ id: 1, state: 'not_visible' }])
    })
})
