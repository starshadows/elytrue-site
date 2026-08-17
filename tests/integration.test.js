// EdgeOne Blob 集成测试:仅在明确设置测试环境变量时运行,否则自动跳过。
//
// 用法:
//   EDGEONE_TEST_PROJECT_ID=<项目ID> EDGEONE_TEST_TOKEN=<API Token> node --test tests/integration.test.js
//
// 要求:
//   - 使用独立测试前缀,不访问生产数据;
//   - 测试结束后清理全部写入的 key;
//   - 连接的是项目下已有的 Blob Store(默认 elytrue-data,可用 EDGEONE_TEST_STORE 覆盖)。
import assert from 'node:assert/strict'
import test from 'node:test'
import { getStore } from '@edgeone/pages-blob'
import { handleApiRequest } from '../server/app.js'
import { blobKeys } from '../server/domain/blob-keys.js'
import { getJSON, isPreconditionFailure, listAll } from '../server/storage.js'
import { sha256, keyedDigest } from '../server/crypto.js'
import { normalizeEmail } from '../shared/validation.js'
import { withLatestViewLock } from '../server/services/comment-view-service.js'

const projectId = process.env.EDGEONE_TEST_PROJECT_ID
const token = process.env.EDGEONE_TEST_TOKEN
const RUN = Boolean(projectId && token)
const STORE_NAME = process.env.EDGEONE_TEST_STORE || 'elytrue-data'

const PREFIX = `integration-test/${Date.now().toString(36)}/`
const secret = process.env.ELYTRUE_TEST_APP_SECRET || 'integration-test-secret-that-is-longer-than-32-chars'
const origin = 'https://integration.elytrue.test'
const env = {
    ELYTRUE_APP_SECRET: secret,
    PUBLIC_SITE_URL: origin,
    ADMIN_BOOTSTRAP_SECRET: 'integration-bootstrap-secret',
    ALLOWED_ORIGINS: origin,
}

const skipReason = 'EDGEONE_TEST_PROJECT_ID / EDGEONE_TEST_TOKEN 未设置,跳过集成测试'

function store() {
    return getStore({ name: STORE_NAME, projectId, token, consistency: 'strong' })
}

async function cleanup(data) {
    const blobs = await listAll(data, PREFIX, Infinity).catch(() => [])
    for (const blob of blobs) await data.delete(blob.key).catch(() => {})
}

test('EdgeOne contract: onlyIfNew conditional write works on real Blob', { skip: RUN ? false : skipReason }, async () => {
    const data = store()
    const key = `${PREFIX}onlyifnew.json`
    try {
        await data.setJSON(key, { value: 1 }, { onlyIfNew: true })
        await assert.rejects(
            () => data.setJSON(key, { value: 2 }, { onlyIfNew: true }),
            error => isPreconditionFailure(error) && error.name === 'PreconditionFailedError',
        )
        const value = await getJSON(data, key)
        assert.equal(value.value, 1)
        // 不带 onlyIfNew 可覆盖
        await data.setJSON(key, { value: 3 })
        assert.equal((await getJSON(data, key)).value, 3)
    } finally {
        await data.delete(key).catch(() => {})
    }
})

test('strong consistency reads are visible immediately after writes', { skip: RUN ? false : skipReason }, async () => {
    const data = store()
    const key = `${PREFIX}strong.json`
    try {
        await data.setJSON(key, { now: Date.now() })
        const read = await data.get(key, { type: 'json', consistency: 'strong' })
        assert.ok(read.now > 0)
    } finally {
        await data.delete(key).catch(() => {})
    }
})

test('EdgeOne contract: strong list is server-bounded and key-ordered', { skip: RUN ? false : skipReason }, async () => {
    const data = store()
    const keys = []
    try {
        const insertionOrder = Array.from({ length: 30 }, (_, index) => index)
            .sort((left, right) => (left * 17) % 31 - (right * 17) % 31)
        for (const i of insertionOrder) {
            const key = `${PREFIX}list/${String(i).padStart(4, '0')}.json`
            await data.setJSON(key, { i })
            keys.push(key)
        }
        const limited = await data.list({
            prefix: `${PREFIX}list/`,
            limit: 25,
            paginate: false,
            consistency: 'strong',
        })
        assert.equal(limited.blobs.length, 25)
        assert.deepEqual(
            limited.blobs.map(blob => blob.key),
            keys.slice().sort().slice(0, 25),
        )
        assert.ok(limited.cursor)
    } finally {
        await cleanup(data)
    }
})

test('EdgeOne contract: independent clients serialize latest lock ownership', { skip: RUN ? false : skipReason }, async () => {
    const prefix = `${PREFIX}latest-lock/`
    const adapt = data => ({
        setJSON: (key, value, options) => data.setJSON(`${prefix}${key}`, value, options),
        get: (key, options) => data.get(`${prefix}${key}`, options),
        delete: key => data.delete(`${prefix}${key}`),
    })
    const first = adapt(store())
    const second = adapt(store())
    let active = 0
    let maxActive = 0
    let enteredResolve
    const entered = new Promise(resolve => {
        enteredResolve = resolve
    })
    try {
        const firstRequest = withLatestViewLock(first, async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            enteredResolve()
            await new Promise(resolve => setTimeout(resolve, 350))
            active -= 1
        })
        await entered
        const secondRequest = withLatestViewLock(second, async () => {
            active += 1
            maxActive = Math.max(maxActive, active)
            active -= 1
        })
        await Promise.all([firstRequest, secondRequest])
        assert.equal(maxActive, 1)
        assert.equal(
            await getJSON(store(), `${prefix}${blobKeys.commentsLatestLock}`),
            null,
            'owner must release the production lock',
        )

        await store().setJSON(`${prefix}${blobKeys.commentsLatestLock}`, {
            owner: 'stale-owner',
            createdAt: Date.now() - 61_000,
        })
        let recovered = false
        await withLatestViewLock(first, async () => {
            recovered = true
        })
        assert.equal(recovered, true)
        assert.equal(
            await getJSON(store(), `${prefix}${blobKeys.commentsLatestLock}`),
            null,
            'stale lock must be recovered and the new owner released',
        )
    } finally {
        await cleanup(store())
    }
})

test('concurrent registrations of the same username settle at one winner', { skip: RUN ? false : skipReason }, async () => {
    const data = store()
    const name = `集成测试${Date.now().toString(36)}`
    const emails = [`${Date.now().toString(36)}-a@example.com`, `${Date.now().toString(36)}-b@example.com`]
    const createdKeys = new Set()
    try {
        const results = await Promise.all(emails.map(async (email, index) => {
            const response = await handleApiRequest({
                request: new Request(`${origin}/api/user/register`, {
                    method: 'POST',
                    headers: new Headers({
                        Origin: origin,
                        'Content-Type': 'application/json',
                    }),
                    body: JSON.stringify({ name, email, password: 'integration-secure-password' }),
                }),
                env,
                clientIp: `203.0.113.${10 + index}`,
            }, { data, uploads: store() })
            const payload = response.headers.get('content-type')?.includes('application/json')
                ? await response.json()
                : null
            if (payload?.data?.id) {
                createdKeys.add(`users/${payload.data.id}.json`)
                createdKeys.add(`indexes/users/name/${sha256(name.normalize('NFKC').trim().toLowerCase())}.json`)
                createdKeys.add(`indexes/users/email/${keyedDigest(secret, normalizeEmail(email), 'email-index')}.json`)
            }
            return response.status
        }))
        assert.deepEqual(results.slice().sort(), [201, 409])
    } finally {
        for (const key of createdKeys) await data.delete(key).catch(() => {})
    }
})

test('concurrent comment posts get distinct public numbers', { skip: RUN ? false : skipReason }, async () => {
    const data = store()
    const email = `${Date.now().toString(36)}-c@example.com`
    const name = `留言${Date.now().toString(36)}`
    const createdKeys = new Set()
    let sessionToken = ''
    try {
        const register = await handleApiRequest({
            request: new Request(`${origin}/api/user/register`, {
                method: 'POST',
                headers: new Headers({ Origin: origin, 'Content-Type': 'application/json' }),
                body: JSON.stringify({ name, email, password: 'integration-secure-password' }),
            }),
            env,
            clientIp: '203.0.113.120',
        }, { data, uploads: store() })
        const payload = await register.json()
        const userId = payload.data?.id
        assert.ok(userId)
        createdKeys.add(`users/${userId}.json`)
        createdKeys.add(`indexes/users/name/${sha256(name.normalize('NFKC').trim().toLowerCase())}.json`)
        createdKeys.add(`indexes/users/email/${keyedDigest(secret, normalizeEmail(email), 'email-index')}.json`)
        for (const header of register.headers.getSetCookie?.() || []) {
            const pair = header.split(';', 1)[0]
            const i = pair.indexOf('=')
            if (pair.slice(0, i) === 'elytrue_session') sessionToken = decodeURIComponent(pair.slice(i + 1))
        }
        assert.ok(sessionToken)
        createdKeys.add(`sessions/${sha256(sessionToken)}.json`)

        const csrf = payload.data?.csrfToken
        const results = await Promise.all([1, 2].map(async () => {
            const response = await handleApiRequest({
                request: new Request(`${origin}/api/comments/post`, {
                    method: 'POST',
                    headers: new Headers({
                        Origin: origin,
                        Cookie: `elytrue_session=${encodeURIComponent(sessionToken)}`,
                        'X-CSRF-Token': csrf,
                        'Content-Type': 'application/json',
                    }),
                    body: JSON.stringify({ comment: `并发留言 ${Date.now()}` }),
                }),
                env,
                clientIp: '203.0.113.120',
            }, { data, uploads: store() })
            const body = await response.json()
            if (body?.data?.id) {
                createdKeys.add(`comments/${String(body.data.id).padStart(16, '0')}.json`)
                createdKeys.add(`indexes/comments/number/${body.data.number}.json`)
                createdKeys.add(`indexes/comments/by-user/${userId}/${String(body.data.id).padStart(16, '0')}.json`)
            }
            return body.data
        }))
        const numbers = results.map(result => result?.number).filter(Boolean)
        assert.equal(numbers.length, 2, '两条并发留言都应成功')
        assert.equal(new Set(numbers).size, 2, '并发留言编号不得重复')
    } finally {
        await cleanup(data)
        for (const key of createdKeys) await data.delete(key).catch(() => {})
    }
})

test('runs against the configured store with independent prefix', { skip: RUN ? false : skipReason }, async () => {
    const data = store()
    const key = `${PREFIX}probe.json`
    try {
        await data.setJSON(key, { ok: true })
        assert.equal((await getJSON(data, key)).ok, true)
    } finally {
        await data.delete(key).catch(() => {})
    }
})
