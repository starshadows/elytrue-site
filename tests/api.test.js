import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { handleApiRequest } from '../server/app.js'
import { MemoryStore } from '../server/storage.js'
import { encryptEmail, keyedDigest, sha256 } from '../server/crypto.js'
import { requestOriginAllowed } from '../server/http.js'
import { normalizeUsername } from '../shared/validation.js'
import { updateUser } from '../server/auth.js'

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

function nameIndexKey(name) {
    return `indexes/users/name/${sha256(normalizeUsername(name))}.json`
}

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

describe('EdgeOne account and session API', () => {
    const state = createState('10.0.0.1')
    let resetToken
    let sentEmail
    const originalFetch = globalThis.fetch

    before(() => {
        globalThis.fetch = async (_url, init) => {
            sentEmail = JSON.parse(init.body)
            return new Response(JSON.stringify({ id: 'email-test' }), {
                status: 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }
    })

    after(() => {
        globalThis.fetch = originalFetch
    })

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
        assert.match(state.csrfToken, /^[a-zA-Z0-9_-]+$/u)
    })

    it('sends a one-time reset link and revokes old sessions after use', async () => {
        const oldSession = new Map(state.jar)
        const requested = await call(state, 'POST', 'user/resetpassword', {
            identifier: '星花旅人',
        })
        assert.equal(requested.response.status, 200)
        assert.equal(sentEmail.to[0], 'owner@example.com')
        const match = sentEmail.html.match(/#resetpassword=([a-zA-Z0-9_-]+)/u)
        assert.ok(match)
        resetToken = match[1]

        const resetState = createState('10.0.0.4')
        resetState.stores = state.stores
        const reset = await call(resetState, 'POST', 'action', {
            id: resetToken,
            data: 'a-new-secure-password',
        })
        assert.equal(reset.response.status, 200)

        const reuse = await call(resetState, 'POST', 'action', {
            id: resetToken,
            data: 'another-new-password',
        })
        assert.equal(reuse.response.status, 400)

        state.jar = oldSession
        const oldMe = await call(state, 'GET', 'user/me')
        assert.equal(oldMe.response.status, 401)

        const newLogin = await call(state, 'POST', 'user/login', {
            identifier: 'owner@example.com',
            password: 'a-new-secure-password',
        })
        assert.equal(newLogin.response.status, 200)
    })

    it('returns the same reset response for an unknown account', async () => {
        const unknown = createState('10.0.0.5')
        unknown.stores = state.stores
        const result = await call(unknown, 'POST', 'user/resetpassword', {
            identifier: 'does-not-exist@example.com',
        })
        assert.equal(result.response.status, 200)
        assert.match(result.payload.message, /如果账号存在/u)
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
        assert.deepEqual(newest.payload.data.map(comment => comment.displayId), [2, 1])
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
})

describe('password reset observability and health', () => {
    const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
    const state = createState('10.0.4.1')
    state.stores = stores
    let capturedLogs

    function captureLogs() {
        capturedLogs = []
        const capture = (...args) => capturedLogs.push(args.join(' '))
        const original = { log: console.log, error: console.error }
        console.log = capture
        console.error = capture
        return () => {
            console.log = original.log
            console.error = original.error
        }
    }

    it('reports health with version and build time', async () => {
        const result = await call(state, 'GET', 'health')
        assert.equal(result.response.status, 200)
        assert.equal(result.payload.data.status, 'ok')
        assert.equal(typeof result.payload.data.version, 'string')
        assert.ok('buildTime' in result.payload.data)
    })

    it('logs a structured success entry with email id, without leaking the token', async () => {
        await call(state, 'POST', 'user/register', {
            name: '邮件用户',
            email: 'mail@example.com',
            password: 'mail-secure-password',
        })
        const sent = {}
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (_url, init) => {
            sent.body = JSON.parse(init.body)
            return new Response(JSON.stringify({ id: 'email-xyz' }), { status: 200 })
        }
        const restore = captureLogs()
        try {
            const requested = await call(state, 'POST', 'user/resetpassword', {
                identifier: 'mail@example.com',
            })
            assert.equal(requested.response.status, 200)
            assert.match(requested.payload.message, /如果账号存在/u)
            assert.ok(sent.body.from)
            assert.equal(sent.body.from.includes('noreply@mail.elytrue.com'), true)
        } finally {
            restore()
            globalThis.fetch = originalFetch
        }

        const entry = capturedLogs.map(text => JSON.parse(text))
            .find(log => log?.event === 'password_reset_email')
        assert.ok(entry, 'expected structured log entry')
        assert.equal(entry.success, true)
        assert.equal(entry.provider, 'resend')
        assert.equal(entry.emailId, 'email-xyz')
        assert.ok(entry.userId)

        const token = sent.body.html.match(/#resetpassword=([a-zA-Z0-9_-]+)/u)?.[1]
        assert.ok(token)
        assert.ok(sent.body.html.includes(`${origin}/#resetpassword=`), 'reset link uses PUBLIC_SITE_URL')
        assert.equal(capturedLogs.some(text => text.includes(token)), false)
        assert.equal(capturedLogs.some(text => text.includes('mail-secure-password')), false)
    })

    it('logs a structured failure when RESEND_API_KEY is missing', async () => {
        const noKeyState = createState('10.0.4.2')
        noKeyState.stores = stores
        const restore = captureLogs()
        let result
        try {
            result = await call(noKeyState, 'POST', 'user/resetpassword', {
                identifier: 'mail@example.com',
            }, {
                env: { ...env, RESEND_API_KEY: '' },
            })
        } finally {
            restore()
        }
        assert.equal(result.response.status, 200)
        assert.match(result.payload.message, /如果账号存在/u)

        const entry = capturedLogs.map(text => JSON.parse(text))
            .find(log => log?.event === 'password_reset_email')
        assert.ok(entry, 'expected structured log entry')
        assert.equal(entry.success, false)
        assert.match(entry.error, /RESEND_API_KEY/u)
        assert.ok(entry.userId)
    })

    it('logs a structured failure with status for non-2xx responses', async () => {
        const failState = createState('10.0.4.3')
        failState.stores = stores
        const originalFetch = globalThis.fetch
        globalThis.fetch = async () => new Response('domain is not verified', { status: 403 })
        const restore = captureLogs()
        let result
        try {
            result = await call(failState, 'POST', 'user/resetpassword', {
                identifier: 'mail@example.com',
            })
        } finally {
            restore()
            globalThis.fetch = originalFetch
        }
        assert.equal(result.response.status, 200)

        const entry = capturedLogs.map(text => JSON.parse(text))
            .find(log => log?.event === 'password_reset_email')
        assert.equal(entry.success, false)
        assert.equal(entry.status, 403)
        assert.match(entry.error, /domain is not verified/u)
    })

    it('expires reset tokens and allows only one use', async () => {
        const resetUser = createState('10.0.4.4')
        resetUser.stores = stores
        await call(resetUser, 'POST', 'user/register', {
            name: '过期用户',
            email: 'expire@example.com',
            password: 'expire-secure-password',
        })
        const sent = {}
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (_url, init) => {
            sent.body = JSON.parse(init.body)
            return new Response(JSON.stringify({ id: 'email-expire' }), { status: 200 })
        }
        try {
            await call(resetUser, 'POST', 'user/resetpassword', { identifier: 'expire@example.com' })
        } finally {
            globalThis.fetch = originalFetch
        }
        const token = sent.body.html.match(/#resetpassword=([a-zA-Z0-9_-]+)/u)?.[1]
        assert.ok(token)

        // 找到属于该用户的重置记录并置为过期(store 中可能还有其他用户的记录)
        const me = await call(resetUser, 'GET', 'user/me')
        const resetUserId = me.payload.data.id
        const listing = await stores.data.list({ prefix: 'password-resets/' })
        const resetEntries = []
        for (const blob of listing.blobs) {
            const record = await stores.data.get(blob.key, { type: 'json' })
            if (record?.userId === resetUserId) resetEntries.push({ key: blob.key, record })
        }
        assert.equal(resetEntries.length, 1)
        resetEntries[0].record.expiresAt = Date.now() - 1000
        await stores.data.setJSON(resetEntries[0].key, resetEntries[0].record)

        const expired = await call(resetUser, 'POST', 'action', {
            id: token,
            data: 'new-password-123',
        })
        assert.equal(expired.response.status, 400)

        // 重新生成并立即使用,再复用应失败
        const sent2 = {}
        globalThis.fetch = async (_url, init) => {
            sent2.body = JSON.parse(init.body)
            return new Response(JSON.stringify({ id: 'email-expire-2' }), { status: 200 })
        }
        try {
            await call(resetUser, 'POST', 'user/resetpassword', { identifier: 'expire@example.com' })
        } finally {
            globalThis.fetch = originalFetch
        }
        const token2 = sent2.body.html.match(/#resetpassword=([a-zA-Z0-9_-]+)/u)?.[1]
        assert.ok(token2)
        const used = await call(resetUser, 'POST', 'action', {
            id: token2,
            data: 'another-new-password',
        })
        assert.equal(used.response.status, 200)
        const reuse = await call(resetUser, 'POST', 'action', {
            id: token2,
            data: 'third-new-password',
        })
        assert.equal(reuse.response.status, 400)
    })

    it('allows only one of two concurrent uses of the same reset token', async () => {
        const raceUser = createState('10.0.4.5')
        raceUser.stores = stores
        await call(raceUser, 'POST', 'user/register', {
            name: '并发重置用户',
            email: 'race-reset@example.com',
            password: 'race-reset-password',
        })
        const sent = {}
        const originalFetch = globalThis.fetch
        globalThis.fetch = async (_url, init) => {
            sent.body = JSON.parse(init.body)
            return new Response(JSON.stringify({ id: 'email-race' }), { status: 200 })
        }
        try {
            await call(raceUser, 'POST', 'user/resetpassword', { identifier: 'race-reset@example.com' })
        } finally {
            globalThis.fetch = originalFetch
        }
        const token = sent.body.html.match(/#resetpassword=([a-zA-Z0-9_-]+)/u)?.[1]
        assert.ok(token)

        const results = await Promise.all([
            call(raceUser, 'POST', 'action', { id: token, data: 'first-winner-password' }),
            call(raceUser, 'POST', 'action', { id: token, data: 'second-loser-password' }),
        ])
        assert.deepEqual(results.map(result => result.response.status).sort(), [200, 400])
        const loser = results.find(result => result.response.status === 400)
        assert.match(loser.payload.message, /无效或已使用/u)
        const winner = results.find(result => result.response.status === 200)
        assert.ok(winner)

        // 旧会话全部失效,只能用赢家设置的新密码登录
        const oldMe = await call(raceUser, 'GET', 'user/me')
        assert.equal(oldMe.response.status, 401)
        const newLogin = await call(raceUser, 'POST', 'user/login', {
            identifier: 'race-reset@example.com',
            password: 'first-winner-password',
        })
        assert.equal(newLogin.response.status, 200)
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
