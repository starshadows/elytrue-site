import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { handleApiRequest } from '../server/app.js'
import { MemoryStore } from '../server/storage.js'
import {
    encryptEmail,
    keyedDigest,
    sha256,
    verifyRecoveryKey,
} from '../server/crypto.js'
import { requestOriginAllowed } from '../server/http.js'
import { normalizeUsername } from '../shared/validation.js'
import { findUserById, updateUser } from '../server/auth.js'
import { resetMemoryRateLimitsForTests } from '../server/rate-limit.js'
import { bootstrapAdministrator } from '../server/services/admin-service.js'
import { auditUploadStorage } from '../scripts/audit-upload-storage.mjs'
import {
    compensateAvatarUpdate,
    deleteAvatar,
    prepareAvatarUpdate,
    validateImageUpload,
} from '../server/services/image-service.js'

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

class SilentConditionalStore extends MemoryStore {
    async setJSON(key, value, options = {}) {
        if (options.onlyIfNew && this.values.has(key)) return
        return super.setJSON(key, value, options)
    }
}

class AvatarActivationStore extends MemoryStore {
    constructor() {
        super()
        this.failActivation = false
    }

    async setJSON(key, value, options = {}) {
        if (
            this.failActivation
            && key.startsWith('uploads/aliases/avatars/')
            && value?.status === 'active'
        ) {
            throw new Error('injected avatar activation failure')
        }
        return super.setJSON(key, value, options)
    }
}

class AvatarBlobDeleteStore extends MemoryStore {
    constructor() {
        super()
        this.failNextAvatarDelete = false
    }

    async delete(key) {
        if (this.failNextAvatarDelete && key.startsWith('avatars/')) {
            this.failNextAvatarDelete = false
            throw new Error('injected avatar blob delete failure')
        }
        return super.delete(key)
    }
}

class AmbiguousUserWriteStore extends MemoryStore {
    constructor() {
        super()
        this.failNextUserWrite = false
        this.failUserReconciliationRead = false
    }

    async setJSON(key, value, options = {}) {
        if (this.failNextUserWrite && key.startsWith('users/')) {
            this.failNextUserWrite = false
            await super.setJSON(key, value, options)
            this.failUserReconciliationRead = true
            throw new Error('injected ambiguous user write')
        }
        return super.setJSON(key, value, options)
    }

    async get(key, options = {}) {
        if (this.failUserReconciliationRead && key.startsWith('users/')) {
            this.failUserReconciliationRead = false
            throw new Error('injected reconciliation read failure')
        }
        return super.get(key, options)
    }
}

class AmbiguousIndexClaimStore extends MemoryStore {
    constructor() {
        super()
        this.failVerificationFor = ''
        this.failNextVerificationRead = false
    }

    async setJSON(key, value, options = {}) {
        await super.setJSON(key, value, options)
        if (key === this.failVerificationFor) this.failNextVerificationRead = true
    }

    async get(key, options = {}) {
        if (key === this.failVerificationFor && this.failNextVerificationRead) {
            this.failNextVerificationRead = false
            throw new Error('injected index verification failure')
        }
        return super.get(key, options)
    }
}

class PausedProfileClaimStore extends MemoryStore {
    constructor() {
        super()
        this.pauseNextProfileClaim = false
        this.profileClaimStarted = Promise.resolve()
        this.releaseProfileClaim = () => {}
    }

    pauseProfileClaim() {
        this.pauseNextProfileClaim = true
        this.profileClaimStarted = new Promise(resolve => {
            this.markProfileClaimStarted = resolve
        })
        this.profileClaimRelease = new Promise(resolve => {
            this.releaseProfileClaim = resolve
        })
    }

    async setJSON(key, value, options = {}) {
        if (
            this.pauseNextProfileClaim
            && key.startsWith('recovery-key-claims/')
            && value?.type === 'profile-update'
        ) {
            this.pauseNextProfileClaim = false
            this.markProfileClaimStarted()
            await this.profileClaimRelease
        }
        return super.setJSON(key, value, options)
    }
}

function nameIndexKey(name) {
    return `indexes/users/name/${sha256(normalizeUsername(name))}.json`
}

const origin = 'https://preview.elytrue.test'
const env = {
    ELYTRUE_APP_SECRET: 'test-only-secret-that-is-longer-than-thirty-two-characters',
    PUBLIC_SITE_URL: origin,
    ADMIN_BOOTSTRAP_SECRET: 'test-admin-bootstrap-secret',
    ALLOWED_ORIGINS: origin,
}

function createState(ip = '127.0.0.1') {
    return {
        ip,
        jar: new Map(),
        csrfToken: '',
        stores: {
            data: new MemoryStore(),
            uploads: new MemoryStore(),
        },
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

async function loginWorksWithSharedStore(stores, identifier, password, ip) {
    const state = createState(ip)
    state.stores = stores
    const result = await call(state, 'POST', 'user/login', { identifier, password })
    return result.response.status
}

describe('EdgeOne account and session API', () => {
    const state = createState('10.0.0.1')
    let recoveryKey

    it('registers immediately with required username, email and password', async () => {
        const { response, payload } = await call(state, 'POST', 'user/register', {
            name: '星花旅人',
            email: 'owner@example.com',
            password: 'correct-horse-battery-staple',
        })
        assert.equal(response.status, 201)
        assert.equal(payload.code, 1)
        assert.equal(payload.data.name, '星花旅人')
        assert.equal(payload.data.email, 'owner@example.com')
        assert.equal(payload.data.role, 'admin')
        assert.match(
            payload.data.recoveryKey,
            /^ELY-(?:[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}-){6}[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{4}$/u,
        )
        recoveryKey = payload.data.recoveryKey
        assert.ok(state.jar.has('elytrue_session'))
        assert.equal(state.jar.has('elytrue_csrf'), false)
        assert.match(state.csrfToken, /^[a-zA-Z0-9_-]+$/u)
        assert.equal(response.headers.getSetCookie().length, 1)
    })

    it('rejects duplicate usernames and emails case-insensitively', async () => {
        const duplicateName = createState('10.0.0.2')
        duplicateName.stores = state.stores
        const nameResult = await call(duplicateName, 'POST', 'user/register', {
            name: '星花旅人',
            email: 'other@example.com',
            password: 'another-secure-password',
        })
        assert.equal(nameResult.response.status, 409)

        const duplicateEmail = createState('10.0.0.3')
        duplicateEmail.stores = state.stores
        const emailResult = await call(duplicateEmail, 'POST', 'user/register', {
            name: '另一位旅人',
            email: 'OWNER@EXAMPLE.COM',
            password: 'another-secure-password',
        })
        assert.equal(emailResult.response.status, 409)
    })

    it('supports username or email login and rejects a wrong password', async () => {
        await call(state, 'POST', 'user/logout')
        const wrong = await call(state, 'POST', 'user/login', {
            identifier: 'owner@example.com',
            password: 'wrong-password',
        })
        assert.equal(wrong.response.status, 401)

        const emailLogin = await call(state, 'POST', 'user/login', {
            identifier: 'OWNER@EXAMPLE.COM',
            password: 'correct-horse-battery-staple',
        })
        assert.equal(emailLogin.response.status, 200)
        assert.equal(emailLogin.payload.data.name, '星花旅人')

        await call(state, 'POST', 'user/logout')
        const usernameLogin = await call(state, 'POST', 'user/login', {
            identifier: '星花旅人',
            password: 'correct-horse-battery-staple',
        })
        assert.equal(usernameLogin.response.status, 200)
    })

    it('keeps private profile behind the HttpOnly session cookie', async () => {
        state.csrfToken = ''
        const me = await call(state, 'GET', 'user/me')
        assert.equal(me.response.status, 200)
        assert.equal(me.payload.data.email, 'owner@example.com')
        assert.equal(me.payload.data.hasEmail, true)
        assert.equal(me.payload.data.hasRecoveryKey, true)
        assert.equal('recoveryKey' in me.payload.data, false)
        assert.match(state.csrfToken, /^[a-zA-Z0-9_-]+$/u)
    })

    it('recovers the account once and revokes every old session', async () => {
        resetMemoryRateLimitsForTests()
        const oldSession = new Map(state.jar)
        const secondSession = createState('10.0.0.4')
        secondSession.stores = state.stores
        const secondLogin = await call(secondSession, 'POST', 'user/login', {
            identifier: 'owner@example.com',
            password: 'correct-horse-battery-staple',
        })
        assert.equal(secondLogin.response.status, 200)

        const resetState = createState('10.0.0.4')
        resetState.stores = state.stores
        const reset = await call(resetState, 'POST', 'user/recover', {
            identifier: '星花旅人',
            recoveryKey,
            password: 'a-new-secure-password',
        })
        assert.equal(reset.response.status, 200)
        assert.match(reset.payload.data.recoveryKey, /^ELY-/u)
        assert.notEqual(reset.payload.data.recoveryKey, recoveryKey)
        assert.equal(resetState.jar.size, 0, 'recovery must not create a session')

        const reuse = await call(resetState, 'POST', 'user/recover', {
            identifier: '星花旅人',
            recoveryKey,
            password: 'another-new-password',
        })
        assert.equal(reuse.response.status, 400)
        assert.equal(reuse.payload.message, '账号信息或恢复密钥不正确')
        assert.equal(reuse.payload.data, null)

        state.jar = oldSession
        const oldMe = await call(state, 'GET', 'user/me')
        assert.equal(oldMe.response.status, 401)
        const otherOldMe = await call(secondSession, 'GET', 'user/me')
        assert.equal(otherOldMe.response.status, 401)

        const oldPassword = await call(state, 'POST', 'user/login', {
            identifier: 'owner@example.com',
            password: 'correct-horse-battery-staple',
        })
        assert.equal(oldPassword.response.status, 401)

        const newLogin = await call(state, 'POST', 'user/login', {
            identifier: 'owner@example.com',
            password: 'a-new-secure-password',
        })
        assert.equal(newLogin.response.status, 200)
        recoveryKey = reset.payload.data.recoveryKey
    })
})

describe('EdgeOne public origin validation', () => {
    it('accepts browser-confirmed same-origin writes when EdgeOne hides the public Host', () => {
        const request = new Request('http://elytrue.internal/api/user/register', {
            method: 'POST',
            headers: {
                Origin: 'https://elytrue-demo.edgeone.app',
                'Sec-Fetch-Site': 'same-origin',
            },
        })
        assert.equal(requestOriginAllowed(request), true)
    })

    it('accepts the public Host when TLS termination changes request.url protocol', () => {
        const request = new Request('http://elytrue.internal/api/user/register', {
            method: 'POST',
            headers: {
                Host: 'elytrue-demo.edgeone.app',
                Origin: 'https://elytrue-demo.edgeone.app',
                'X-Forwarded-Proto': 'https',
            },
        })
        assert.equal(requestOriginAllowed(request), true)
    })

    it('still rejects a forged external Origin', () => {
        const request = new Request('http://elytrue.internal/api/user/register', {
            method: 'POST',
            headers: {
                Host: 'elytrue-demo.edgeone.app',
                Origin: 'https://evil.example',
                'Sec-Fetch-Site': 'cross-site',
                'X-Forwarded-Proto': 'https',
            },
        })
        assert.equal(requestOriginAllowed(request), false)
    })

    it('accepts PUBLIC_SITE_URL as a deployment configuration fallback', () => {
        const request = new Request('http://elytrue.internal/api/user/register', {
            method: 'POST',
            headers: {
                Origin: 'https://elytrue-demo.edgeone.app',
            },
        })
        assert.equal(
            requestOriginAllowed(request, {
                PUBLIC_SITE_URL: 'https://elytrue-demo.edgeone.app/',
            }),
            true,
        )
    })
})

describe('public user lookup', () => {
    async function registeredUser(ip = '10.0.0.30') {
        const state = createState(ip)
        const registered = await call(state, 'POST', 'user/register', {
            name: '公开查询用户',
            email: 'public-find@example.com',
            password: 'public-find-password',
        })
        return { state, profile: registered.payload.data }
    }

    it('finds a normalized username and returns only public fields', async () => {
        resetMemoryRateLimitsForTests()
        const { state, profile } = await registeredUser('10.0.0.30')
        const result = await call(
            state,
            'GET',
            `user/find?name=${encodeURIComponent('  公开查询用户  ')}`,
        )
        assert.equal(result.response.status, 200)
        assert.deepEqual(result.payload.data, [{
            id: profile.id,
            name: '公开查询用户',
            avatar: '',
            create_time: profile.create_time,
            role: 'admin',
        }])
        for (const field of [
            'email',
            'emailCipher',
            'emailHash',
            'passwordHash',
            'hasEmail',
            'hasPassword',
            'hasRecoveryKey',
            'sessionVersion',
        ]) {
            assert.equal(field in result.payload.data[0], false, field)
        }
    })

    it('finds a user by ID without exposing private fields', async () => {
        resetMemoryRateLimitsForTests()
        const { state, profile } = await registeredUser('10.0.0.31')
        const result = await call(state, 'GET', `user/find?id=${profile.id}`)
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data[0].id, profile.id)
        assert.deepEqual(Object.keys(result.payload.data[0]).sort(), [
            'avatar',
            'create_time',
            'id',
            'name',
            'role',
        ])
    })

    it('does not use email-shaped input to find a public user', async () => {
        resetMemoryRateLimitsForTests()
        const { state } = await registeredUser('10.0.0.32')
        const result = await call(state, 'GET', 'user/find?name=public-find%40example.com')
        assert.equal(result.response.status, 200)
        assert.deepEqual(result.payload.data, [])
    })

    it('returns an empty list for an unknown valid username', async () => {
        resetMemoryRateLimitsForTests()
        const state = createState('10.0.0.33')
        const result = await call(state, 'GET', 'user/find?name=不存在用户')
        assert.equal(result.response.status, 200)
        assert.deepEqual(result.payload.data, [])
    })

    it('rejects overlong, illegal, and malformed ID input', async () => {
        resetMemoryRateLimitsForTests()
        const state = createState('10.0.0.34')
        for (const path of [
            `user/find?name=${'a'.repeat(25)}`,
            'user/find?name=%3Cbad%3E',
            'user/find?id=not-a-user-id',
        ]) {
            const result = await call(state, 'GET', path)
            assert.equal(result.response.status, 400)
        }
    })

    it('enforces the Cloud Functions user lookup limit', async () => {
        resetMemoryRateLimitsForTests()
        const state = createState('10.0.0.35')
        for (let index = 0; index < 120; index += 1) {
            const result = await call(state, 'GET', 'user/find?name=不存在用户')
            assert.equal(result.response.status, 200)
        }
        const limited = await call(state, 'GET', 'user/find?name=不存在用户')
        assert.equal(limited.response.status, 429)
    })

    it('does not turn a malformed session cookie into a server error', async () => {
        resetMemoryRateLimitsForTests()
        const state = createState('10.0.0.36')
        const result = await call(state, 'GET', 'user/me', undefined, {
            headers: { Cookie: 'elytrue_session=%E0%A4%A; theme=valid%20theme' },
        })
        assert.equal(result.response.status, 401)
        assert.notEqual(result.response.status, 500)
    })
})

describe('declarative route security policy', () => {
    it('enforces public, optional, session, admin, and CSRF policies', async () => {
        const guest = createState('10.0.0.20')
        assert.equal((await call(guest, 'GET', 'health')).response.status, 200)
        assert.equal((await call(guest, 'GET', 'comments')).response.status, 200)
        assert.equal((await call(guest, 'GET', 'user/me')).response.status, 200)
        assert.equal((await call(guest, 'POST', 'user/logout')).response.status, 401)

        const stores = guest.stores
        const admin = guest
        assert.equal((await call(admin, 'POST', 'user/register', {
            name: '策略管理员',
            email: 'policy-admin@example.com',
            password: 'policy-admin-password',
        })).response.status, 201)
        const member = createState('10.0.0.21')
        member.stores = stores
        assert.equal((await call(member, 'POST', 'user/register', {
            name: '策略普通用户',
            email: 'policy-member@example.com',
            password: 'policy-member-password',
        })).response.status, 201)
        assert.equal((await call(member, 'GET', 'admin/reports')).response.status, 403)

        admin.csrfToken = ''
        assert.equal((await call(admin, 'POST', 'comments/post', { comment: '缺少令牌' })).response.status, 403)
        admin.csrfToken = 'incorrect-csrf-token'
        assert.equal((await call(admin, 'POST', 'comments/post', { comment: '错误令牌' })).response.status, 403)
    })
})

describe('EdgeOne comments, uploads and moderation API', () => {
    const state = createState('10.0.1.1')
    let commentId

    it('requires a signed-in account for posting', async () => {
        const result = await call(state, 'POST', 'comments/post', { comment: '你好' })
        assert.equal(result.response.status, 401)
    })

    it('registers a writer and accepts one validated image upload', async () => {
        await call(state, 'POST', 'user/register', {
            name: '留言者',
            email: 'writer@example.com',
            password: 'writer-secure-password',
        })
        const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nfsAAAAASUVORK5CYII='
        const upload = await call(state, 'POST', 'uploads/image', { image: png })
        assert.equal(upload.response.status, 201)
        assert.ok(upload.payload.data.imageId)

        const posted = await call(state, 'POST', 'comments/post', {
            comment: '<b>愿花与星辉伴你同行</b>',
            imageKeys: [upload.payload.data.imageId],
        })
        assert.equal(posted.response.status, 201)
        commentId = posted.payload.data.id
    })

    it('stores plain text, serves comment images and makes likes idempotent', async () => {
        const listed = await call(state, 'GET', `comments?from=${commentId}&count=1`)
        assert.equal(listed.payload.data[0].comment, '<b>愿花与星辉伴你同行</b>')
        assert.equal(listed.payload.data[0].displayId, 1)
        assert.equal(listed.payload.data[0].likes, 0)
        const imageId = listed.payload.data[0].image

        const image = await call(state, 'GET', `data/images/posts/${imageId}.jpg`)
        assert.equal(image.response.status, 200)
        assert.equal(image.response.headers.get('content-type'), 'image/png')

        assert.equal((await call(state, 'POST', `comments/like?commentId=${commentId}`)).response.status, 200)
        assert.equal((await call(state, 'POST', `comments/like?commentId=${commentId}`)).response.status, 200)
        const liked = await call(state, 'GET', `comments?from=${commentId}&count=1`)
        assert.equal(liked.payload.data[0].likes, 1)
        assert.equal(liked.payload.data[0].liked, true)

        const second = await call(state, 'POST', 'comments/post', { comment: '第二条留言' })
        assert.equal(second.response.status, 201)
        const newest = await call(state, 'GET', 'comments?count=2')
        assert.deepEqual(newest.payload.data.items.map(comment => comment.displayId), [2, 1])
    })

    it('accepts reports from others, rejects self-report and duplicates', async () => {
        const reporter = createState('10.0.1.2')
        reporter.stores = state.stores
        const registered = await call(reporter, 'POST', 'user/register', {
            name: '举报者',
            email: 'reporter@example.com',
            password: 'reporter-secure-password',
        })
        assert.equal(registered.response.status, 201)

        const selfReport = await call(state, 'POST', 'comments/report', {
            commentId,
            reason: '测试自举报',
        })
        assert.equal(selfReport.response.status, 403)
        assert.match(selfReport.payload.message, /不能举报自己的留言/u)

        const report = await call(reporter, 'POST', 'comments/report', {
            commentId,
            reason: '测试举报',
        })
        assert.equal(report.response.status, 200)

        const duplicate = await call(reporter, 'POST', 'comments/report', {
            commentId,
            reason: '重复举报',
        })
        assert.equal(duplicate.response.status, 409)
        assert.match(duplicate.payload.message, /已举报过该留言/u)

        const reports = await call(state, 'GET', 'admin/reports')
        assert.equal(reports.response.status, 200)
        assert.equal(reports.payload.data[0].reason, '测试举报')
        assert.equal(reports.payload.data[0].displayId, 1)

        const hidden = await call(state, 'POST', 'admin/comments/moderate', {
            commentId,
            action: 'hide',
        })
        assert.equal(hidden.response.status, 200)

        // 模拟修复前已经存在的举报记录：它没有新写入的 commentNumber 字段。
        const reportBlobs = await state.stores.data.list({
            prefix: `reports/${commentId}/`,
        })
        const reportKey = reportBlobs.blobs[0].key
        const legacyReport = await state.stores.data.get(reportKey, { type: 'json' })
        delete legacyReport.commentNumber
        await state.stores.data.setJSON(reportKey, legacyReport)

        const removed = await call(state, 'POST', 'admin/comments/moderate', {
            commentId,
            action: 'delete',
        })
        assert.equal(removed.response.status, 200)

        const deletedReports = await call(state, 'GET', 'admin/reports')
        assert.equal(deletedReports.response.status, 200)
        assert.equal(deletedReports.payload.data[0].displayId, 1)
        assert.equal(deletedReports.payload.data[0].deleted, true)
        assert.notEqual(deletedReports.payload.data[0].displayId, commentId)
    })

    it('rejects forged cross-origin writes', async () => {
        const headers = new Headers({
            Origin: 'https://evil.example',
            'Content-Type': 'application/json',
            Cookie: [...state.jar].map(([key, value]) => `${key}=${encodeURIComponent(value)}`).join('; '),
            'X-CSRF-Token': state.csrfToken,
        })
        const response = await handleApiRequest({
            request: new Request(`${origin}/api/comments/post`, {
                method: 'POST',
                headers,
                body: JSON.stringify({ comment: 'forged' }),
            }),
            env,
            clientIp: '10.0.1.1',
        }, state.stores)
        assert.equal(response.status, 403)
    })
})

describe('concurrent uniqueness checks', () => {
    it('assigns exactly one admin during concurrent first registrations', async () => {
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        const first = createState('10.0.2.10')
        const second = createState('10.0.2.11')
        first.stores = stores
        second.stores = stores

        const results = await Promise.all([
            call(first, 'POST', 'user/register', {
                name: '首位甲',
                email: 'first-admin-a@example.com',
                password: 'secure-password-one',
            }),
            call(second, 'POST', 'user/register', {
                name: '首位乙',
                email: 'first-admin-b@example.com',
                password: 'secure-password-two',
            }),
        ])

        assert.deepEqual(
            results.map(result => result.payload.data.role).sort(),
            ['admin', 'user'],
        )
        const marker = await stores.data.get('system/admin-bootstrap-closed.json', {
            type: 'json',
        })
        const admin = results.find(result => result.payload.data.role === 'admin')
        assert.equal(marker.userId, admin.payload.data.id)
        assert.equal(marker.automatic, true)
        const storedAdmin = await stores.data.get(`users/${admin.payload.data.id}.json`, {
            type: 'json',
        })
        assert.equal(storedAdmin.role, 'admin')
    })

    it('keeps registration open for regular users after the first administrator', async () => {
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        const first = createState('10.0.2.20')
        const second = createState('10.0.2.21')
        first.stores = stores
        second.stores = stores

        const administrator = await call(first, 'POST', 'user/register', {
            name: '首位管理员',
            email: 'first-admin@example.com',
            password: 'first-admin-password',
        })
        const regularUser = await call(second, 'POST', 'user/register', {
            name: '后续普通用户',
            email: 'later-regular-user@example.com',
            password: 'later-user-password',
        })

        assert.equal(administrator.response.status, 201)
        assert.equal(administrator.payload.data.role, 'admin')
        assert.equal(regularUser.response.status, 201)
        assert.equal(regularUser.payload.data.role, 'user')

        const marker = await stores.data.get('system/admin-bootstrap-closed.json', {
            type: 'json',
        })
        assert.equal(marker.userId, administrator.payload.data.id)
    })

    it('does not promote a later registration in an existing unmarked store', async () => {
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        await stores.data.setJSON('users/legacy-account.json', {
            id: 'legacy-account',
            role: 'user',
        })
        const state = createState('10.0.2.12')
        state.stores = stores

        const result = await call(state, 'POST', 'user/register', {
            name: '后来用户',
            email: 'later-user@example.com',
            password: 'secure-password-later',
        })

        assert.equal(result.response.status, 201)
        assert.equal(result.payload.data.role, 'user')
        assert.equal(
            await stores.data.get('system/admin-bootstrap-closed.json', { type: 'json' }),
            null,
        )
    })

    it('allows only one registration for the same email', async () => {
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        const first = createState('10.0.2.1')
        const second = createState('10.0.2.2')
        first.stores = stores
        second.stores = stores
        const results = await Promise.all([
            call(first, 'POST', 'user/register', {
                name: '并发甲',
                email: 'race@example.com',
                password: 'secure-password-one',
            }),
            call(second, 'POST', 'user/register', {
                name: '并发乙',
                email: 'RACE@example.com',
                password: 'secure-password-two',
            }),
        ])
        assert.deepEqual(results.map(result => result.response.status).sort(), [201, 409])
    })

    it('allows only one registration for the same username', async () => {
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        const first = createState('10.0.2.3')
        const second = createState('10.0.2.4')
        first.stores = stores
        second.stores = stores
        const results = await Promise.all([
            call(first, 'POST', 'user/register', {
                name: '同名甲',
                email: 'name-race-a@example.com',
                password: 'secure-password-one',
            }),
            call(second, 'POST', 'user/register', {
                name: '同名甲',
                email: 'name-race-b@example.com',
                password: 'secure-password-two',
            }),
        ])
        assert.deepEqual(results.map(result => result.response.status).sort(), [201, 409])
    })
})

describe('registration uniqueness and normalization', () => {
    const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
    const original = createState('10.0.3.1')
    original.stores = stores

    function duplicateState(ip) {
        const state = createState(ip)
        state.stores = stores
        return state
    }

    async function register(state, name, email, password = 'a-secure-password') {
        return call(state, 'POST', 'user/register', { name, email, password })
    }

    it('registers the base account and keeps its indexes intact after failed duplicates', async () => {
        const base = await register(original, '星花旅人', 'owner@example.com')
        assert.equal(base.response.status, 201)

        const nameConflict = await register(duplicateState('10.0.3.2'), '星花旅人', 'other@example.com')
        assert.equal(nameConflict.response.status, 409)
        assert.equal(nameConflict.payload.message, '用户名已被使用')

        const spaced = await register(duplicateState('10.0.3.3'), '  星花旅人  ', 'spaced@example.com')
        assert.equal(spaced.response.status, 409)
        assert.equal(spaced.payload.message, '用户名已被使用')

        const fullWidth = await register(duplicateState('10.0.3.4'), 'ＳＴＡＲＦＬＯＷＥＲ', 'fullwidth@example.com')
        assert.equal(fullWidth.response.status, 201)
        assert.equal(fullWidth.payload.data.name, 'STARFLOWER')

        const caseVariant = await register(duplicateState('10.0.3.5'), 'starflower', 'case@example.com')
        assert.equal(caseVariant.response.status, 409)
        assert.equal(caseVariant.payload.message, '用户名已被使用')

        const emailConflict = await register(duplicateState('10.0.3.6'), '另一位旅人', 'OWNER@example.com')
        assert.equal(emailConflict.response.status, 409)
        assert.equal(emailConflict.payload.message, '邮箱已被注册')

        const emailCase = await register(duplicateState('10.0.3.7'), '再来一位', 'owner@EXAMPLE.com')
        assert.equal(emailCase.response.status, 409)
        assert.equal(emailCase.payload.message, '邮箱已被注册')

        // 失败请求不得破坏原账号索引:仍可分别用用户名和邮箱登录到原账号
        await call(original, 'POST', 'user/logout')
        const nameLogin = await call(original, 'POST', 'user/login', {
            identifier: '星花旅人',
            password: 'a-secure-password',
        })
        assert.equal(nameLogin.response.status, 200)
        assert.equal(nameLogin.payload.data.name, '星花旅人')

        const emailLogin = await call(original, 'POST', 'user/login', {
            identifier: 'owner@example.com',
            password: 'a-secure-password',
        })
        assert.equal(emailLogin.response.status, 200)

        // 后注册的合法账号也能正常登录(索引指向正确)
        const fullWidthLogin = await call(duplicateState('10.0.3.4'), 'POST', 'user/login', {
            identifier: 'starflower',
            password: 'a-secure-password',
        })
        assert.equal(fullWidthLogin.response.status, 200)
        assert.equal(fullWidthLogin.payload.data.name, 'STARFLOWER')
    })

    it('rejects a duplicate username even if conditional storage silently keeps the old value', async () => {
        const silentStores = {
            data: new SilentConditionalStore(),
            uploads: new SilentConditionalStore(),
        }
        const first = createState('10.0.3.8')
        const second = createState('10.0.3.9')
        first.stores = silentStores
        second.stores = silentStores

        const created = await register(first, '不可重复', 'first@example.com')
        assert.equal(created.response.status, 201)

        const duplicate = await register(second, '不可重复', 'second@example.com')
        assert.equal(duplicate.response.status, 409)
        assert.equal(duplicate.payload.message, '用户名已被使用')
    })
})

describe('administrator bootstrap concurrency', () => {
    it('allows only the marker winner to become administrator', async () => {
        const data = new MemoryStore()
        const users = [
            {
                id: '11111111-1111-4111-8111-111111111111',
                name: '初始化甲',
                role: 'user',
                recoveryKeyVersion: 1,
                sessionVersion: 1,
            },
            {
                id: '22222222-2222-4222-8222-222222222222',
                name: '初始化乙',
                role: 'user',
                recoveryKeyVersion: 1,
                sessionVersion: 1,
            },
        ]
        await Promise.all(users.map(user => data.setJSON(`users/${user.id}.json`, user)))

        const results = await Promise.allSettled(users.map(user =>
            bootstrapAdministrator(data, user, 'bootstrap-secret', 'bootstrap-secret'),
        ))
        assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
        assert.equal(results.filter(result => result.status === 'rejected').length, 1)

        const marker = await data.get('system/admin-bootstrap-closed.json', { type: 'json' })
        const records = await Promise.all(users.map(user =>
            data.get(`users/${user.id}.json`, { type: 'json' }),
        ))
        assert.equal(records.filter(user => user.role === 'admin').length, 1)
        assert.equal(records.find(user => user.role === 'admin').id, marker.userId)
        assert.equal((await findUserById(data, marker.userId)).role, 'admin')
    })
})

describe('account recovery security and health', () => {
    const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
    const state = createState('10.0.4.1')
    state.stores = stores

    it('reports health with version and build time', async () => {
        const result = await call(state, 'GET', 'health')
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.status, 'ok')
        assert.equal(typeof result.payload.data.version, 'string')
        assert.ok('buildTime' in result.payload.data)
    })

    it('stores only a slow hash and never logs the registration recovery key', async () => {
        const logs = []
        const original = { log: console.log, error: console.error }
        console.log = (...values) => logs.push(values.join(' '))
        console.error = (...values) => logs.push(values.join(' '))
        let registered
        try {
            registered = await call(state, 'POST', 'user/register', {
                name: '恢复密钥用户',
                email: 'recovery@example.com',
                password: 'recovery-secure-password',
            })
        } finally {
            console.log = original.log
            console.error = original.error
        }

        const recoveryKey = registered.payload.data.recoveryKey
        const userId = registered.payload.data.id
        const stored = await stores.data.get(`users/${userId}.json`, { type: 'json' })
        assert.equal(Math.log2(31) * 28 >= 128, true)
        assert.match(stored.recoveryKeyHash, /^recovery-scrypt\$1\$/u)
        assert.equal(await verifyRecoveryKey(recoveryKey, stored.recoveryKeyHash), true)
        assert.equal(JSON.stringify(stored).includes(recoveryKey), false)
        assert.equal(logs.some(entry => entry.includes(recoveryKey)), false)
    })

    it('keeps legacy accounts usable and lets them create then rotate a key with their password', async () => {
        resetMemoryRateLimitsForTests()
        const legacy = createState('10.0.4.2')
        legacy.stores = stores
        const registered = await call(legacy, 'POST', 'user/register', {
            name: '历史恢复用户',
            email: 'legacy-recovery@example.com',
            password: 'legacy-secure-password',
        })
        const userKey = `users/${registered.payload.data.id}.json`
        const stored = await stores.data.get(userKey, { type: 'json' })
        delete stored.recoveryKeyHash
        delete stored.recoveryKeyCreatedAt
        delete stored.recoveryKeyVersion
        await stores.data.setJSON(userKey, stored)

        await call(legacy, 'POST', 'user/logout')
        const login = await call(legacy, 'POST', 'user/login', {
            identifier: '历史恢复用户',
            password: 'legacy-secure-password',
        })
        assert.equal(login.response.status, 200)
        assert.equal(login.payload.data.hasRecoveryKey, false)

        const wrongPassword = await call(legacy, 'POST', 'user/recovery-key', {
            currentPassword: 'wrong-password',
        })
        assert.equal(wrongPassword.response.status, 401)
        const created = await call(legacy, 'POST', 'user/recovery-key', {
            currentPassword: 'legacy-secure-password',
        })
        assert.equal(created.response.status, 200)
        assert.match(created.payload.data.recoveryKey, /^ELY-/u)

        const rotated = await call(legacy, 'POST', 'user/recovery-key', {
            currentPassword: 'legacy-secure-password',
        })
        assert.equal(rotated.response.status, 200)
        assert.notEqual(rotated.payload.data.recoveryKey, created.payload.data.recoveryKey)
        const latest = await stores.data.get(userKey, { type: 'json' })
        assert.equal(await verifyRecoveryKey(created.payload.data.recoveryKey, latest.recoveryKeyHash), false)
        assert.equal(await verifyRecoveryKey(rotated.payload.data.recoveryKey, latest.recoveryKeyHash), true)
    })

    it('uses the same response for unknown accounts and incorrect recovery keys', async () => {
        resetMemoryRateLimitsForTests()
        const known = createState('10.0.4.3')
        known.stores = stores
        const registered = await call(known, 'POST', 'user/register', {
            name: '统一错误用户',
            email: 'uniform-recovery@example.com',
            password: 'uniform-secure-password',
        })
        const validKey = registered.payload.data.recoveryKey
        const wrongKey = validKey.slice(0, -1) + (validKey.endsWith('2') ? '3' : '2')
        const knownFailure = await call(known, 'POST', 'user/recover', {
            identifier: 'uniform-recovery@example.com',
            recoveryKey: wrongKey,
            password: 'replacement-password',
        })
        const unknown = createState('10.0.4.4')
        unknown.stores = stores
        const unknownFailure = await call(unknown, 'POST', 'user/recover', {
            identifier: 'missing-recovery@example.com',
            recoveryKey: wrongKey,
            password: 'replacement-password',
        })
        assert.equal(knownFailure.response.status, unknownFailure.response.status)
        assert.equal(knownFailure.payload.message, unknownFailure.payload.message)
        assert.equal(knownFailure.payload.message, '账号信息或恢复密钥不正确')
    })

    it('allows only one concurrent use of a recovery key', async () => {
        resetMemoryRateLimitsForTests()
        const race = createState('10.0.4.5')
        race.stores = stores
        const registered = await call(race, 'POST', 'user/register', {
            name: '并发恢复用户',
            email: 'race-recovery@example.com',
            password: 'race-recovery-password',
        })
        const requests = [
            createState('10.0.4.6'),
            createState('10.0.4.7'),
        ]
        requests.forEach(item => (item.stores = stores))
        const results = await Promise.all(requests.map((item, index) => call(
            item,
            'POST',
            'user/recover',
            {
                identifier: 'race-recovery@example.com',
                recoveryKey: registered.payload.data.recoveryKey,
                password: `race-winner-password-${index}`,
            },
        )))
        assert.deepEqual(results.map(result => result.response.status).sort(), [200, 400])
        assert.equal(results.find(result => result.response.status === 400).payload.message, '账号信息或恢复密钥不正确')
        assert.equal(
            await stores.data.get(
                `recovery-key-claims/${registered.payload.data.id}/1.json`,
                { type: 'json' },
            ),
            null,
        )
    })

    it('prevents a stale profile update from overwriting a completed recovery', async () => {
        resetMemoryRateLimitsForTests()
        const data = new PausedProfileClaimStore()
        const stores = { data, uploads: new MemoryStore() }
        const owner = createState('10.0.4.20')
        owner.stores = stores
        const registered = await call(owner, 'POST', 'user/register', {
            name: '恢复竞态用户',
            email: 'recovery-update-race@example.com',
            password: 'recovery-race-old-password',
        })

        data.pauseProfileClaim()
        const staleUpdate = call(owner, 'PUT', 'user/update', {
            name: '不应生效的新名字',
            password: 'stale-profile-password',
        })
        await data.profileClaimStarted

        const recovery = createState('10.0.4.21')
        recovery.stores = stores
        const recovered = await call(recovery, 'POST', 'user/recover', {
            identifier: 'recovery-update-race@example.com',
            recoveryKey: registered.payload.data.recoveryKey,
            password: 'recovery-race-new-password',
        })
        data.releaseProfileClaim()
        const updateResult = await staleUpdate

        assert.equal(recovered.response.status, 200)
        assert.equal(updateResult.response.status, 409)
        assert.equal(await call(owner, 'GET', 'user/me').then(result => result.response.status), 401)
        assert.equal(
            await loginWorksWithSharedStore(
                stores,
                'recovery-update-race@example.com',
                'recovery-race-new-password',
                '10.0.4.22',
            ),
            200,
        )
        assert.equal(
            await loginWorksWithSharedStore(
                stores,
                '不应生效的新名字',
                'stale-profile-password',
                '10.0.4.23',
            ),
            401,
        )
        assert.equal(await data.get(nameIndexKey('不应生效的新名字'), { type: 'json' }), null)
    })

    it('limits repeated recovery attempts by account identity', async () => {
        resetMemoryRateLimitsForTests()
        const attempts = []
        for (let index = 0; index < 6; index += 1) {
            const requester = createState(`10.0.5.${index + 1}`)
            requester.stores = stores
            attempts.push(await call(requester, 'POST', 'user/recover', {
                identifier: 'rate-limited-recovery@example.com',
                recoveryKey: 'ELY-2222-2222-2222-2222-2222-2222-2222',
                password: 'rate-limit-password',
            }))
        }
        assert.deepEqual(attempts.map(result => result.response.status), [400, 400, 400, 400, 400, 429])
    })

    it('validates real calendar dates for comment counts', async () => {
        const cases = [
            ['2026-02-29', 400],
            ['2026-04-31', 400],
            ['2024-02-29', 200],
            ['2026-08-02', 200],
        ]
        for (const [date, expected] of cases) {
            const result = await call(state, 'GET', `comments/count?date=${date}`)
            assert.equal(result.response.status, expected, `日期 ${date} 应返回 ${expected}`)
        }
    })

    it('reports version, build time and commit time', async () => {
        const result = await call(state, 'GET', 'health')
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.service, 'elytrue-edgeone')
        assert.equal(result.payload.data.status, 'ok')
        assert.equal(typeof result.payload.data.version, 'string')
        assert.ok('buildTime' in result.payload.data)
        assert.ok('commitTime' in result.payload.data)
    })

})

describe('updateUser index transaction', () => {
    const origin = 'https://preview.elytrue.test'

    async function registerIn(ip, name, email, password = 'update-secure-password', stores) {
        const state = createState(ip)
        state.stores = stores || { data: new MemoryStore(), uploads: new MemoryStore() }
        await call(state, 'POST', 'user/register', { name, email, password })
        return state
    }

    async function loginWorks(ip, stores, identifier, password = 'update-secure-password') {
        const state = createState(ip)
        state.stores = stores
        const result = await call(state, 'POST', 'user/login', { identifier, password })
        return result.response.status
    }

    it('rolls back the claimed name index when the user record write fails', async () => {
        const state = await registerIn('10.0.13.1', '旧名甲', 'tx-a@example.com')
        const oldKey = nameIndexKey('旧名甲')
        const originalValues = state.stores.data.values
        assert.ok(await state.stores.data.get(oldKey, { type: 'json' }))

        state.stores.data = new FlakyStore({ setJSON: key => key.startsWith('users/') })
        state.stores.data.values = originalValues
        const failed = await call(state, 'PUT', 'user/update', { name: '新名甲' })
        assert.equal(failed.response.status, 500)

        // 新索引已回滚,旧索引与旧用户名仍可用
        assert.equal(await state.stores.data.get(nameIndexKey('新名甲'), { type: 'json' }), null)
        assert.ok(await state.stores.data.get(oldKey, { type: 'json' }))
        assert.equal(await loginWorks('10.0.13.2', state.stores, '旧名甲'), 200)
        assert.equal(await loginWorks('10.0.13.3', state.stores, '新名甲'), 401)
    })

    it('rolls back the claimed name index when the new email conflicts', async () => {
        const shared = { data: new MemoryStore(), uploads: new MemoryStore() }
        await registerIn('10.0.14.1', '他人乙', 'taken@example.com', 'update-secure-password', shared)
        const state = await registerIn('10.0.14.2', '旧名乙', 'tx-b@example.com', 'update-secure-password', shared)

        const failed = await call(state, 'PUT', 'user/update', {
            name: '新名乙',
            email: 'taken@example.com',
        })
        assert.equal(failed.response.status, 409)
        assert.match(failed.payload.message, /邮箱已被注册/u)

        assert.equal(await state.stores.data.get(nameIndexKey('新名乙'), { type: 'json' }), null, '新用户名索引必须回滚')
        assert.ok(await state.stores.data.get(nameIndexKey('旧名乙'), { type: 'json' }))
        assert.equal(await loginWorks('10.0.14.3', state.stores, '旧名乙'), 200, '旧用户名仍可登录')
        assert.equal(await loginWorks('10.0.14.4', state.stores, 'tx-b@example.com'), 200, '旧邮箱仍可登录')
    })

    it('rolls back the claimed email index when the user record write fails', async () => {
        const state = await registerIn('10.0.15.1', '邮箱甲', 'tx-c@example.com')
        const originalValues = state.stores.data.values
        state.stores.data = new FlakyStore({ setJSON: key => key.startsWith('users/') })
        state.stores.data.values = originalValues
        const failed = await call(state, 'PUT', 'user/update', { email: 'new-mail@example.com' })
        assert.equal(failed.response.status, 500)

        assert.equal(await loginWorks('10.0.15.2', state.stores, 'new-mail@example.com'), 401, '新邮箱索引应回滚')
        assert.equal(await loginWorks('10.0.15.3', state.stores, 'tx-c@example.com'), 200, '旧邮箱仍可登录')
    })

    it('logs a structured error when deleting the old index fails after a successful update', async () => {
        const state = await registerIn('10.0.16.1', '旧名丁', 'tx-d@example.com')
        const oldKey = nameIndexKey('旧名丁')
        const originalValues = state.stores.data.values
        state.stores.data = new FlakyStore({ delete: key => key === oldKey })
        state.stores.data.values = originalValues
        const captured = []
        const original = console.error
        console.error = (...args) => captured.push(args.join(' '))
        let result
        try {
            result = await call(state, 'PUT', 'user/update', { name: '新名丁' })
        } finally {
            console.error = original
        }
        assert.equal(result.response.status, 200, '本体写入成功,旧索引删除失败不影响结果')
        assert.ok(captured.some(text => text.includes('user_old_index_delete_failed')))
        assert.equal(await loginWorks('10.0.16.2', state.stores, '新名丁'), 200, '新用户名可登录')
        // 旧索引删除失败 → 旧索引残留指向同一用户(已记日志),旧名仍能登录,待修复任务清理
        assert.equal(await loginWorks('10.0.16.3', state.stores, '旧名丁'), 200, '旧索引残留,旧名仍可登录(已记录日志)')
    })
})

describe('updateUser pre-validation and index ownership', () => {
    async function registerIn(ip, name, email, password = 'update-secure-password', stores) {
        const state = createState(ip)
        state.stores = stores || { data: new MemoryStore(), uploads: new MemoryStore() }
        await call(state, 'POST', 'user/register', { name, email, password })
        return state
    }

    async function loginWorks(ip, stores, identifier, password = 'update-secure-password') {
        const state = createState(ip)
        state.stores = stores
        const result = await call(state, 'POST', 'user/login', { identifier, password })
        return result.response.status
    }

    it('rejects invalid email format before any index claim', async () => {
        const state = await registerIn('10.0.18.1', '预校验甲', 'tx-e@example.com')
        const failed = await call(state, 'PUT', 'user/update', {
            name: '新名戊',
            email: 'not-an-email',
        })
        assert.equal(failed.response.status, 400)
        assert.match(failed.payload.message, /邮箱格式不正确/u)
        assert.equal(await state.stores.data.get(nameIndexKey('新名戊'), { type: 'json' }), null, '不得留下新用户名索引')
        assert.equal(await loginWorks('10.0.18.2', state.stores, '预校验甲'), 200)
    })

    it('rejects invalid password format before any index claim', async () => {
        const state = await registerIn('10.0.19.1', '预校验乙', 'tx-f@example.com')
        const failed = await call(state, 'PUT', 'user/update', {
            name: '新名己',
            password: 'short',
        })
        assert.equal(failed.response.status, 400)
        assert.match(failed.payload.message, /密码长度/u)
        assert.equal(await state.stores.data.get(nameIndexKey('新名己'), { type: 'json' }), null)
        assert.equal(await loginWorks('10.0.19.2', state.stores, '预校验乙'), 200)
    })

    it('leaves no claimed indexes when password hashing fails mid-update', async () => {
        // 直测 updateUser:注入会抛错的 hashPassword,验证预计算先于任何索引写入
        const data = new MemoryStore()
        const secret = 'x'.repeat(40)
        const email = 'tx-g@example.com'
        const user = {
            id: 'unit-update-user',
            name: '预校验丙',
            emailHash: keyedDigest(secret, email, 'email-index'),
            emailCipher: encryptEmail(secret, email),
            passwordHash: 'old-hash',
            sessionVersion: 1,
        }
        const env2 = { ELYTRUE_APP_SECRET: secret }
        await data.setJSON(`users/${user.id}.json`, { ...user, updatedAt: 1 })
        await assert.rejects(
            () => updateUser(data, null, env2, user, {
                name: '新名庚',
                email: 'new-hash@example.com',
                password: 'a-new-secure-password',
            }, {
                hashPassword: async () => { throw new Error('hash password failure') },
            }),
            /hash password failure/u,
        )
        assert.equal(await data.get(nameIndexKey('新名庚'), { type: 'json' }), null, '新用户名索引必须不产生')
        assert.equal(await data.get(nameIndexKey('预校验丙'), { type: 'json' }), null, '不得产生任何新索引')
        // 数据库中的旧本体未被改动
        const record = await data.get(`users/${user.id}.json`, { type: 'json' })
        assert.equal(record.name, '预校验丙')
        assert.equal(record.emailHash, user.emailHash)
        assert.equal(record.passwordHash, 'old-hash')
    })

    it('never deletes an old name index owned by another historical account', async () => {
        const shared = { data: new MemoryStore(), uploads: new MemoryStore() }
        await registerIn('10.0.21.1', '历史重名', 'tx-h@example.com', 'update-secure-password', shared)
        const state = await registerIn('10.0.21.2', '重名新主', 'tx-i@example.com', 'update-secure-password', shared)
        const otherId = (await call(state, 'GET', 'user/me')).payload.data.id === undefined
            ? null
            : null
        // 历史重复数据:把「重名新主」的旧名索引改指另一个账号
        const me = await call(state, 'GET', 'user/me')
        const myId = me.payload.data.id
        const legacyId = (await call(state, 'GET', `user/find?name=${encodeURIComponent('历史重名')}`)).payload.data[0].id
        assert.notEqual(legacyId, myId)
        await state.stores.data.setJSON(nameIndexKey('重名新主'), { userId: legacyId })

        const captured = []
        const original = console.error
        console.error = (...args) => captured.push(args.join(' '))
        let result
        try {
            result = await call(state, 'PUT', 'user/update', { name: '全新名字' })
        } finally {
            console.error = original
        }
        assert.equal(result.response.status, 200)
        assert.ok(captured.some(text => text.includes('user_old_index_not_owned')), '必须记录非本人索引日志')
        // 旧索引保留并仍指向历史账号,未被删除
        const oldIndex = await state.stores.data.get(nameIndexKey('重名新主'), { type: 'json' })
        assert.equal(oldIndex.userId, legacyId, '不得删除他人索引')
        // 新索引指向本人
        const newIndex = await state.stores.data.get(nameIndexKey('全新名字'), { type: 'json' })
        assert.equal(newIndex.userId, myId)
        void otherId
    })
})

describe('transactional avatar updates', () => {
    const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nfsAAAAASUVORK5CYII='

    async function registerAvatarUser(ip, stores, name, email) {
        resetMemoryRateLimitsForTests()
        const state = createState(ip)
        state.stores = stores || { data: new MemoryStore(), uploads: new MemoryStore() }
        const result = await call(state, 'POST', 'user/register', {
            name,
            email,
            password: 'avatar-transaction-password',
        })
        assert.equal(result.response.status, 201)
        return { state, userId: result.payload.data.id }
    }

    function keysWithPrefix(store, prefix) {
        return [...store.values.keys()].filter(key => key.startsWith(prefix))
    }

    async function usageBytes(data) {
        return Number((await data.get('usage/uploads.json', { type: 'json' }))?.uploadedBytes || 0)
    }

    it('does not write an avatar Blob when the new username conflicts', async () => {
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        await registerAvatarUser('10.0.30.1', stores, '头像占用用户', 'avatar-taken-name@example.com')
        const { state } = await registerAvatarUser('10.0.30.2', stores, '头像更新用户甲', 'avatar-owner-a@example.com')
        const silentStore = new SilentConditionalStore()
        silentStore.values = stores.data.values
        stores.data = silentStore

        const result = await call(state, 'PUT', 'user/update', {
            name: '头像占用用户',
            avatar: png,
        })

        assert.equal(result.response.status, 409)
        assert.equal(stores.uploads.values.size, 0)
        assert.equal(keysWithPrefix(stores.data, 'operations/avatar-updates/').length, 0)
    })

    it('does not write an avatar Blob when the new email conflicts', async () => {
        const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
        await registerAvatarUser('10.0.31.1', stores, '头像邮箱占用者', 'avatar-taken@example.com')
        const { state } = await registerAvatarUser('10.0.31.2', stores, '头像更新用户乙', 'avatar-owner-b@example.com')

        const result = await call(state, 'PUT', 'user/update', {
            email: 'avatar-taken@example.com',
            avatar: png,
        })

        assert.equal(result.response.status, 409)
        assert.equal(stores.uploads.values.size, 0)
        assert.equal(keysWithPrefix(stores.data, 'operations/avatar-updates/').length, 0)
    })

    it('rolls back an index whose claim cannot be verified before upload', async () => {
        const stores = { data: new AmbiguousIndexClaimStore(), uploads: new MemoryStore() }
        const { state } = await registerAvatarUser(
            '10.0.31.3',
            stores,
            '头像索引回滚用户',
            'avatar-index-rollback@example.com',
        )
        const claimedKey = nameIndexKey('头像索引待确认')
        stores.data.failVerificationFor = claimedKey

        const result = await call(state, 'PUT', 'user/update', {
            name: '头像索引待确认',
            avatar: png,
        })

        assert.equal(result.response.status, 500)
        assert.equal(await stores.data.get(claimedKey, { type: 'json' }), null)
        assert.equal(stores.uploads.values.size, 0)
        assert.equal(keysWithPrefix(stores.data, 'operations/avatar-updates/').length, 0)
    })

    it('fully compensates a prepared avatar when the user write fails', async () => {
        const { state } = await registerAvatarUser(
            '10.0.32.1',
            undefined,
            '头像回滚用户',
            'avatar-rollback@example.com',
        )
        const originalValues = state.stores.data.values
        state.stores.data = new FlakyStore({ setJSON: key => key.startsWith('users/') })
        state.stores.data.values = originalValues

        const result = await call(state, 'PUT', 'user/update', {
            name: '头像回滚新名',
            avatar: png,
        })

        assert.equal(result.response.status, 500)
        assert.equal(state.stores.uploads.values.size, 0)
        assert.equal(await usageBytes(state.stores.data), 0)
        assert.equal(await state.stores.data.get(nameIndexKey('头像回滚新名'), { type: 'json' }), null)
        const operationKey = keysWithPrefix(state.stores.data, 'operations/avatar-updates/')[0]
        const operation = await state.stores.data.get(operationKey, { type: 'json' })
        assert.equal(operation.phase, 'rolled-back')
        assert.equal(keysWithPrefix(state.stores.data, 'uploads/aliases/avatars/').length, 0)
        assert.equal(keysWithPrefix(state.stores.data, 'repairs/avatar-update/').length, 0)
    })

    it('preserves and repairs an avatar when the user write result is ambiguous', async () => {
        const stores = { data: new AmbiguousUserWriteStore(), uploads: new MemoryStore() }
        const { state, userId } = await registerAvatarUser(
            '10.0.32.2',
            stores,
            '头像不确定用户',
            'avatar-ambiguous@example.com',
        )
        stores.data.failNextUserWrite = true

        const result = await call(state, 'PUT', 'user/update', {
            name: '头像不确定新名',
            avatar: png,
        })

        assert.equal(result.response.status, 500)
        const user = await stores.data.get(`users/${userId}.json`, { type: 'json' })
        assert.equal(user.name, '头像不确定新名')
        assert.ok(user.avatarKey)
        assert.equal(keysWithPrefix(stores.uploads, 'avatars/').length, 1)
        assert.equal(
            (await stores.data.get(
                `uploads/aliases/avatars/${user.avatarKey}.json`,
                { type: 'json' },
            )).status,
            'pending',
        )
        assert.ok(await stores.data.get(nameIndexKey('头像不确定新名'), { type: 'json' }))
        assert.equal(keysWithPrefix(stores.data, 'repairs/avatar-update/').length, 1)

        const repaired = await auditUploadStorage(stores.data, stores.uploads, { fix: true })
        assert.deepEqual(repaired.openOperations, [])
        assert.deepEqual(repaired.repairMarkers, [])
        assert.equal(
            (await stores.data.get(
                `uploads/aliases/avatars/${user.avatarKey}.json`,
                { type: 'json' },
            )).status,
            'active',
        )
    })

    it('keeps a repairable operation when alias activation fails after the user write', async () => {
        const stores = { data: new AvatarActivationStore(), uploads: new MemoryStore() }
        const { state, userId } = await registerAvatarUser(
            '10.0.33.1',
            stores,
            '头像激活用户',
            'avatar-activation@example.com',
        )
        stores.data.failActivation = true

        const result = await call(state, 'PUT', 'user/update', { avatar: png })

        assert.equal(result.response.status, 500)
        const user = await stores.data.get(`users/${userId}.json`, { type: 'json' })
        assert.ok(user.avatarKey)
        const alias = await stores.data.get(
            `uploads/aliases/avatars/${user.avatarKey}.json`,
            { type: 'json' },
        )
        assert.equal(alias.status, 'pending')
        const operation = await stores.data.get(
            `operations/avatar-updates/${alias.operationId}.json`,
            { type: 'json' },
        )
        assert.equal(operation.phase, 'repair-needed')
        assert.ok(await stores.data.get(
            `repairs/avatar-update/${alias.operationId}.json`,
            { type: 'json' },
        ))
    })

    it('keeps only the current avatar after three consecutive replacements', async () => {
        const { state } = await registerAvatarUser(
            '10.0.34.1',
            undefined,
            '头像三连用户',
            'avatar-three@example.com',
        )
        const avatarIds = []
        for (let index = 0; index < 3; index += 1) {
            const result = await call(state, 'PUT', 'user/update', { avatar: png })
            assert.equal(result.response.status, 200)
            avatarIds.push(result.payload.data.avatar)
        }

        assert.equal(new Set(avatarIds).size, 3)
        assert.deepEqual(
            keysWithPrefix(state.stores.data, 'uploads/aliases/avatars/'),
            [`uploads/aliases/avatars/${avatarIds[2]}.json`],
        )
        assert.equal(keysWithPrefix(state.stores.uploads, 'avatars/').length, 1)
        assert.equal(await usageBytes(state.stores.data), Buffer.from(png, 'base64').length)
        assert.equal(keysWithPrefix(state.stores.data, 'operations/avatar-deletes/').length, 2)
        const image = await call(state, 'GET', `data/images/avatars/${avatarIds[2]}`)
        assert.equal(image.response.status, 200)
        assert.equal(
            image.response.headers.get('cache-control'),
            'public, max-age=300, must-revalidate',
        )
        assert.equal(typeof image.response.headers.get('content-type'), 'string')
        assert.equal((await call(state, 'GET', 'user/me')).payload.data.avatar, avatarIds[2])
    })

    it('does not apply usage twice when a prepared operation is retried', async () => {
        const { state, userId } = await registerAvatarUser(
            '10.0.35.1',
            undefined,
            '头像幂等用户',
            'avatar-idempotent@example.com',
        )
        const user = await state.stores.data.get(`users/${userId}.json`, { type: 'json' })
        const preparedImage = validateImageUpload(png, 'avatar')
        const operationId = '00000000-0000-4000-8000-000000000099'

        const first = await prepareAvatarUpdate(
            state.stores,
            user,
            preparedImage,
            '',
            { operationId },
        )
        await prepareAvatarUpdate(state.stores, user, preparedImage, '', { operationId })
        assert.equal(await usageBytes(state.stores.data), Buffer.from(png, 'base64').length)

        const second = await prepareAvatarUpdate(
            state.stores,
            user,
            preparedImage,
            '',
            { operationId: '00000000-0000-4000-8000-000000000100' },
        )
        await deleteAvatar(state.stores, user.id, first.newAvatarId)
        await compensateAvatarUpdate(state.stores, first)
        await compensateAvatarUpdate(state.stores, first)
        assert.equal(await usageBytes(state.stores.data), Buffer.from(png, 'base64').length)
        await compensateAvatarUpdate(state.stores, second)
        assert.equal(await usageBytes(state.stores.data), 0)
    })

    it('retries cleanup after an old avatar Blob deletion failure', async () => {
        const stores = { data: new MemoryStore(), uploads: new AvatarBlobDeleteStore() }
        const { state } = await registerAvatarUser(
            '10.0.36.1',
            stores,
            '头像清理用户',
            'avatar-cleanup@example.com',
        )
        const first = await call(state, 'PUT', 'user/update', { avatar: png })
        stores.uploads.failNextAvatarDelete = true
        const second = await call(state, 'PUT', 'user/update', { avatar: png })

        assert.equal(second.response.status, 200)
        const oldAvatarId = first.payload.data.avatar
        const updateOperation = await stores.data.get(
            `operations/avatar-updates/${second.payload.data.avatar}.json`,
            { type: 'json' },
        )
        assert.equal(updateOperation.phase, 'cleanup-needed')
        assert.ok(keysWithPrefix(stores.uploads, 'avatars/').length > 1)

        await deleteAvatar(stores, second.payload.data.id, oldAvatarId)
        assert.equal(keysWithPrefix(stores.uploads, 'avatars/').length, 1)
        assert.equal(await usageBytes(stores.data), Buffer.from(png, 'base64').length)
    })

    it('cleans the current avatar when the user restores the default', async () => {
        const { state } = await registerAvatarUser(
            '10.0.36.2',
            undefined,
            '默认头像用户',
            'avatar-default@example.com',
        )
        const uploaded = await call(state, 'PUT', 'user/update', { avatar: png })
        assert.equal(uploaded.response.status, 200)

        const cleared = await call(state, 'PUT', 'user/update', { avatar: '' })

        assert.equal(cleared.response.status, 200)
        assert.equal(cleared.payload.data.avatar, '')
        assert.equal(keysWithPrefix(state.stores.data, 'uploads/aliases/avatars/').length, 0)
        assert.equal(keysWithPrefix(state.stores.uploads, 'avatars/').length, 0)
        assert.equal(await usageBytes(state.stores.data), 0)
    })

    it('does not serve a pending avatar from the public endpoint', async () => {
        const { state, userId } = await registerAvatarUser(
            '10.0.37.1',
            undefined,
            '头像待定用户',
            'avatar-pending@example.com',
        )
        const user = await state.stores.data.get(`users/${userId}.json`, { type: 'json' })
        const operation = await prepareAvatarUpdate(
            state.stores,
            user,
            validateImageUpload(png, 'avatar'),
            '',
        )

        const result = await call(
            state,
            'GET',
            `data/images/avatars/${operation.newAvatarId}`,
        )
        assert.equal(result.response.status, 404)
        await compensateAvatarUpdate(state.stores, operation)
    })

    it('allows only one concurrent profile update to commit', async () => {
        const { state } = await registerAvatarUser(
            '10.0.38.1',
            undefined,
            '头像并发用户',
            'avatar-concurrent@example.com',
        )
        const peer = createState('10.0.38.2')
        peer.stores = state.stores
        peer.jar = new Map(state.jar)
        peer.csrfToken = state.csrfToken

        const results = await Promise.all([
            call(state, 'PUT', 'user/update', { avatar: png }),
            call(peer, 'PUT', 'user/update', { avatar: png }),
        ])

        assert.deepEqual(results.map(result => result.response.status).sort(), [200, 409])
        assert.equal(keysWithPrefix(state.stores.data, 'uploads/aliases/avatars/').length, 1)
        assert.equal(keysWithPrefix(state.stores.uploads, 'avatars/').length, 1)
        assert.equal(await usageBytes(state.stores.data), Buffer.from(png, 'base64').length)
    })
})
