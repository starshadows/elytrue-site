import test from 'node:test'
import assert from 'node:assert/strict'
import { middleware, RATE_LIMIT_POLICIES } from '../middleware.js'
import { resolveTrustedClientAddress } from '../shared/client-identity.js'

class MemoryKV {
    values = new Map()

    async get(key) {
        return this.values.get(key) ?? null
    }

    async put(key, value) {
        assert.match(key, /^[A-Za-z0-9_]+$/u)
        this.values.set(key, String(value))
    }

    async delete(key) {
        this.values.delete(key)
    }

    async list({ prefix }) {
        return {
            complete: true,
            cursor: null,
            keys: [...this.values.keys()]
                .filter((key) => key.startsWith(prefix))
                .map((key) => ({ key })),
        }
    }
}

function createContext(pathname, kv, clientIp = '203.0.113.10', options = {}) {
    const request = new Request(`https://preview.example${pathname}`, {
        method: options.method || 'POST',
        headers: options.headers,
    })
    if (options.edgeIp) Object.defineProperty(request, 'eo', { value: { clientIp: options.edgeIp } })
    return {
        request,
        clientIp,
        env: { ELYTRUE_RATE_LIMIT_KV: kv },
        next: () => new Response('next'),
        redirect: (url, status) => Response.redirect(url, status),
        waitUntil: (promise) => promise,
    }
}

class BurstKV extends MemoryKV {
    pendingReads = []

    async get(key) {
        return new Promise(resolve => {
            this.pendingReads.push(() => resolve(this.values.get(key) ?? null))
            if (this.pendingReads.length < 25) return
            const reads = this.pendingReads.splice(0)
            for (const release of reads) release()
        })
    }
}

test('rate-limit policy actions produce valid EdgeOne KV keys', () => {
    for (const policy of Object.values(RATE_LIMIT_POLICIES)) {
        assert.match(policy.action, /^[A-Za-z0-9_]+$/u)
    }
})

test('trusted platform identity overrides forged proxy headers', () => {
    const request = new Request('https://preview.example/api/user/register', {
        headers: {
            'x-forwarded-for': '198.51.100.90',
            'cf-connecting-ip': '198.51.100.91',
        },
    })
    Object.defineProperty(request, 'eo', { value: { clientIp: '203.0.113.20' } })
    assert.equal(
        resolveTrustedClientAddress(request, { clientIp: '203.0.113.21' }),
        '203.0.113.20',
    )
    const untrustedOnly = new Request(request.url, { headers: request.headers })
    assert.equal(resolveTrustedClientAddress(untrustedOnly, {}), null)
})

test('middleware applies document-only CSP while keeping API and binary responses distinct', async () => {
    const htmlContext = createContext('/', new MemoryKV())
    htmlContext.next = () => new Response('<!doctype html>', {
        headers: { 'content-type': 'text/html; charset=utf-8' },
    })
    const html = await middleware(htmlContext)
    assert.match(html.headers.get('content-security-policy'), /script-src 'self'/u)
    assert.doesNotMatch(
        html.headers.get('content-security-policy'),
        /script-src[^;]*unsafe-inline/u,
    )
    assert.equal(html.headers.get('x-frame-options'), 'DENY')
    assert.equal(
        html.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains',
    )

    const apiContext = createContext('/api/health', new MemoryKV())
    apiContext.next = () => Response.json({ ok: true })
    const api = await middleware(apiContext)
    assert.equal(api.headers.get('content-security-policy'), null)
    assert.equal(
        api.headers.get('strict-transport-security'),
        'max-age=31536000; includeSubDomains',
    )

    const binaryContext = createContext(
        '/assets/elytrue-shell-20260805/default-avatar-320-dd2f4539.png',
        new MemoryKV(),
    )
    binaryContext.next = () => new Response(new Uint8Array([1]), {
        headers: { 'content-type': 'image/png' },
    })
    const binary = await middleware(binaryContext)
    assert.equal(binary.headers.get('content-security-policy'), null)
    assert.equal(binary.headers.get('x-content-type-options'), 'nosniff')
})

test('middleware allows requests within the edge rate limit', async () => {
    const kv = new MemoryKV()
    for (let index = 0; index < 20; index += 1) {
        const response = await middleware(createContext('/api/user/register', kv))
        assert.equal(response.status, 200)
        assert.equal(await response.text(), 'next')
    }
})

test('middleware returns the shared API envelope after the edge rate limit', async () => {
    const kv = new MemoryKV()
    for (let index = 0; index < 20; index += 1) {
        await middleware(createContext('/api/user/register', kv))
    }

    const response = await middleware(createContext('/api/user/register', kv))
    assert.equal(response.status, 429)
    assert.deepEqual(await response.json(), {
        code: 429,
        message: '操作过于频繁，请稍后再试',
        data: null,
    })
})

test('documents best-effort behavior for a concurrent KV read-modify-write burst', async () => {
    const kv = new BurstKV()
    const results = await Promise.all(Array.from({ length: 25 }, () =>
        middleware(createContext('/api/user/register', kv)),
    ))
    assert.equal(results.every(response => response.status === 200), true)
    assert.equal(kv.values.size, 1)
})

test('middleware limits account recovery by client IP', async () => {
    const kv = new MemoryKV()
    for (let index = 0; index < 5; index += 1) {
        const response = await middleware(createContext('/api/user/recover', kv))
        assert.equal(response.status, 200)
    }
    const limited = await middleware(createContext('/api/user/recover', kv))
    assert.equal(limited.status, 429)
    assert.equal(
        [...kv.values.keys()].some(key => key.includes('example.com') || key.includes('ELY-')),
        false,
    )
})

test('middleware limits public user lookup by trusted client IP', async () => {
    const kv = new MemoryKV()
    for (let index = 0; index < 120; index += 1) {
        const response = await middleware(createContext('/api/user/find?id=test', kv, '203.0.113.40', {
            method: 'GET',
        }))
        assert.equal(response.status, 200)
    }
    const limited = await middleware(createContext('/api/user/find?id=test', kv, '203.0.113.40', {
        method: 'GET',
    }))
    assert.equal(limited.status, 429)
})

test('middleware does not create a site-wide registration bucket without a client IP', async () => {
    const kv = new MemoryKV()
    for (let index = 0; index < 25; index += 1) {
        const response = await middleware(createContext('/api/user/register', kv, ''))
        assert.equal(response.status, 200)
    }
    assert.equal(kv.values.size, 0)
})

test('forged proxy headers cannot create or switch a rate-limit bucket', async () => {
    const kv = new MemoryKV()
    for (let index = 0; index < 25; index += 1) {
        const context = createContext('/api/user/register', kv, '', {
            headers: { 'x-forwarded-for': `198.51.100.${index}` },
        })
        assert.equal((await middleware(context)).status, 200)
    }
    assert.equal(kv.values.size, 0)
})

test('only configured methods consume a rate-limit window', async () => {
    const kv = new MemoryKV()
    for (const method of ['GET', 'HEAD', 'OPTIONS', 'DELETE']) {
        const response = await middleware(createContext('/api/user/register', kv, '203.0.113.30', { method }))
        assert.equal(response.status, 200)
    }
    assert.equal(kv.values.size, 0)
    await middleware(createContext('/api/user/register', kv, '203.0.113.30'))
    assert.equal(kv.values.size, 1)
})

test('a new fixed window restores the edge allowance', async () => {
    const kv = new MemoryKV()
    const originalNow = Date.now
    try {
        Date.now = () => 1_800_000_000_000
        for (let index = 0; index < 5; index += 1) {
            assert.equal((await middleware(createContext('/api/user/recover', kv))).status, 200)
        }
        assert.equal((await middleware(createContext('/api/user/recover', kv))).status, 429)
        Date.now = () => 1_800_003_600_000
        assert.equal((await middleware(createContext('/api/user/recover', kv))).status, 200)
    } finally {
        Date.now = originalNow
    }
})

test('middleware keeps canonical host redirect ahead of API handling', async () => {
    const context = createContext('/api/user/register', new MemoryKV())
    context.request = new Request('https://www.elytrue.com/api/user/register', { method: 'POST' })
    context.redirect = (url, status) => new Response(url, { status })

    const response = await middleware(context)
    assert.equal(response.status, 301)
    assert.equal(await response.text(), 'https://elytrue.com/api/user/register')
})
