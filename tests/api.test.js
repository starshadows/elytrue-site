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
        env,
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
    })

    it('accepts reports and permanently closes the first-admin bootstrap', async () => {
        const report = await call(state, 'POST', 'comments/report', {
            commentId,
            reason: '测试举报',
        })
        assert.equal(report.response.status, 200)

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
})
