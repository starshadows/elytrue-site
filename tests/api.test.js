import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { handleApiRequest } from '../server/app.js'
import { MemoryStore } from '../server/storage.js'

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

        const bootstrap = await call(state, 'POST', 'admin/bootstrap', undefined, {
            headers: { 'X-Admin-Bootstrap-Secret': env.ADMIN_BOOTSTRAP_SECRET },
        })
        assert.equal(bootstrap.response.status, 200)

        const second = await call(state, 'POST', 'admin/bootstrap', undefined, {
            headers: { 'X-Admin-Bootstrap-Secret': env.ADMIN_BOOTSTRAP_SECRET },
        })
        assert.equal(second.response.status, 410)

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
})
