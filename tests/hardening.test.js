import assert from 'node:assert/strict'
import { afterEach, test } from 'node:test'
import { handleApiRequest } from '../server/app.js'
import { resetMemoryRateLimitsForTests } from '../server/rate-limit.js'
import { MemoryStore } from '../server/storage.js'

const origin = 'https://hardening.elytrue.test'
const configuredEnv = {
  ELYTRUE_APP_SECRET: 'hardening-test-secret-with-at-least-thirty-two-characters',
  PUBLIC_SITE_URL: origin,
  ALLOWED_ORIGINS: origin,
  ELYTRUE_RATE_LIMIT_KV: { get: async () => null, put: async () => {} },
}

afterEach(() => resetMemoryRateLimitsForTests())

async function call(stores, path, {
  method = 'GET',
  body,
  clientIp = '',
  env = configuredEnv,
} = {}) {
  const headers = new Headers({ Origin: origin })
  if (body !== undefined) headers.set('content-type', 'application/json')
  const response = await handleApiRequest({
    request: new Request(`${origin}/api/${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    }),
    clientIp,
    env,
  }, stores)
  const payload = response.headers.get('content-type')?.includes('json')
    ? await response.json()
    : null
  return { response, payload }
}

test('health reports degraded without exposing the missing binding name', async () => {
  const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
  const result = await call(stores, 'health', {
    env: { ...configuredEnv, ELYTRUE_RATE_LIMIT_KV: undefined },
  })

  assert.equal(result.response.status, 200)
  assert.equal(result.payload.data.status, 'degraded')
  assert.equal(result.payload.data.checks.rateLimitKv, 'degraded')
  assert.doesNotMatch(
    JSON.stringify(result.payload),
    /ELYTRUE_RATE_LIMIT_KV|hardening-test-secret/iu,
  )
})

test('account rate limiting still works without a trusted IP', async () => {
  const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
  const identifier = 'no-ip-rate-limit@example.com'
  const registered = await call(stores, 'user/register', {
    method: 'POST',
    clientIp: '203.0.113.50',
    body: {
      name: '无IP限流用户',
      email: identifier,
      password: 'registered-password',
    },
  })
  assert.equal(registered.response.status, 201)

  const statuses = []
  for (let index = 0; index < 13; index += 1) {
    statuses.push((await call(stores, 'user/login', {
      method: 'POST',
      body: { identifier, password: 'incorrect-password' },
    })).response.status)
  }
  assert.deepEqual(statuses, [...Array(12).fill(401), 429])
})

test('default-avatar compatibility redirect uses the versioned asset', async () => {
  const stores = { data: new MemoryStore(), uploads: new MemoryStore() }
  const result = await call(stores, 'data/images/defaultAvatar.png')
  assert.equal(result.response.status, 302)
  assert.equal(
    new URL(result.response.headers.get('location')).pathname,
    '/assets/elytrue-shell-20260805/default-avatar-320-dd2f4539.png',
  )
  assert.equal(result.response.headers.get('cache-control'), 'no-store')
})
