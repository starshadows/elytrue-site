import test from 'node:test'
import assert from 'node:assert/strict'
import { middleware } from '../middleware.js'

class MemoryKV {
    values = new Map()

    async get(key) {
        return this.values.get(key) ?? null
    }

    async put(key, value) {
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

function createContext(pathname, kv, clientIp = '203.0.113.10') {
    return {
        request: new Request(`https://preview.example${pathname}`, { method: 'POST' }),
        clientIp,
        env: { ELYTRUE_RATE_LIMIT_KV: kv },
        next: () => new Response('next'),
        redirect: (url, status) => Response.redirect(url, status),
        waitUntil: (promise) => promise,
    }
}

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

test('middleware does not create a site-wide registration bucket without a client IP', async () => {
    const kv = new MemoryKV()
    for (let index = 0; index < 25; index += 1) {
        const response = await middleware(createContext('/api/user/register', kv, ''))
        assert.equal(response.status, 200)
    }
    assert.equal(kv.values.size, 0)
})

test('middleware keeps canonical host redirect ahead of API handling', async () => {
    const context = createContext('/api/user/register', new MemoryKV())
    context.request = new Request('https://www.elytrue.com/api/user/register', { method: 'POST' })
    context.redirect = (url, status) => new Response(url, { status })

    const response = await middleware(context)
    assert.equal(response.status, 301)
    assert.equal(await response.text(), 'https://elytrue.com/api/user/register')
})
