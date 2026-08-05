import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import { readFile } from 'node:fs/promises'
import {
    createSession,
    destroySession,
    getSession,
} from '../server/auth.js'
import {
    apiResponse,
    binaryResponse,
    DOCUMENT_SECURITY_HEADERS,
    isSecureRequest,
    parseCookies,
} from '../server/http.js'
import {
    API_SECURITY_HEADERS,
    BINARY_SECURITY_HEADERS,
    TRANSPORT_SECURITY_HEADERS,
} from '../shared/security-headers.js'
import { blobKeys } from '../server/domain/blob-keys.js'
import { MemoryStore } from '../server/storage.js'

const user = {
    id: '00000000-0000-4000-8000-000000000001',
    sessionVersion: 1,
}

function request(url, headers = {}) {
    return new Request(url, { headers })
}

describe('secure request detection', () => {
    test('accepts an HTTPS request URL', () => {
        assert.equal(isSecureRequest(request('https://elytrue.example/api')), true)
    })

    test('accepts EdgeOne forwarded HTTPS metadata', () => {
        assert.equal(isSecureRequest(request('http://internal/api', {
            'X-Forwarded-Proto': 'https, http',
        })), true)
    })

    test('uses an HTTPS PUBLIC_SITE_URL for an internal HTTP URL', () => {
        assert.equal(isSecureRequest(request('http://internal/api'), {
            PUBLIC_SITE_URL: 'https://elytrue.example',
        }), true)
    })

    test('keeps local HTTP cookies usable', () => {
        assert.equal(isSecureRequest(request('http://127.0.0.1:8788/api')), false)
    })
})

describe('cookie parsing', () => {
    test('decodes normal encoded cookie values', () => {
        assert.deepEqual(parseCookies(request('https://elytrue.example/api', {
            Cookie: 'theme=%E6%98%9F%E8%8A%B1',
        })), { theme: '星花' })
    })

    test('preserves equals signs in cookie values', () => {
        assert.deepEqual(parseCookies(request('https://elytrue.example/api', {
            Cookie: 'token=header.payload=signature',
        })), { token: 'header.payload=signature' })
    })

    test('keeps a malformed percent-encoded cookie value deterministically', () => {
        assert.deepEqual(parseCookies(request('https://elytrue.example/api', {
            Cookie: 'broken=%E0%A4%A',
        })), { broken: '%E0%A4%A' })
    })

    test('does not let a malformed cookie affect valid cookies', () => {
        assert.deepEqual(parseCookies(request('https://elytrue.example/api', {
            Cookie: 'first=valid%20value; broken=%ZZ; last=a%3Db',
        })), {
            first: 'valid value',
            broken: '%ZZ',
            last: 'a=b',
        })
    })
})

describe('session cookie security', () => {
    test('session creation uses the shared secure request decision', async () => {
        const data = new MemoryStore()
        const result = await createSession(
            data,
            user,
            request('http://internal/api', { 'X-Forwarded-Proto': 'https' }),
        )
        assert.match(result.cookies[0], /;\s*Secure/u)
    })

    test('sliding renewal uses PUBLIC_SITE_URL behind TLS termination', async () => {
        const data = new MemoryStore()
        await data.setJSON(blobKeys.user(user.id), user)
        const created = await createSession(data, user, request('http://local/api'))
        const token = created.cookies[0].match(/^elytrue_session=([^;]+)/u)[1]
        const key = [...data.values.keys()].find(value => value.startsWith('sessions/'))
        const session = await data.get(key, { type: 'json' })
        session.lastSeenAt = Date.now() - 25 * 60 * 60 * 1000
        await data.setJSON(key, session)

        const auth = await getSession(
            data,
            request('http://internal/api', {
                Cookie: `elytrue_session=${token}`,
            }),
            { env: { PUBLIC_SITE_URL: 'https://elytrue.example' } },
        )
        assert.equal(auth.refreshCookies.length, 1)
        assert.match(auth.refreshCookies[0], /;\s*Secure/u)
    })

    test('logout deletion uses the shared decision and removes the session', async () => {
        const data = new MemoryStore()
        await data.setJSON(blobKeys.user(user.id), user)
        const created = await createSession(data, user, request('http://local/api'))
        const token = created.cookies[0].match(/^elytrue_session=([^;]+)/u)[1]
        const auth = await getSession(data, request('http://local/api', {
            Cookie: `elytrue_session=${token}`,
        }))
        const cookies = await destroySession(
            data,
            request('http://internal/api'),
            auth,
            { PUBLIC_SITE_URL: 'https://elytrue.example' },
        )
        assert.match(cookies[0], /Max-Age=0/u)
        assert.match(cookies[0], /;\s*Secure/u)
        assert.equal(await getSession(data, request('http://local/api', {
            Cookie: `elytrue_session=${token}`,
        })), null)
    })
})

test('security headers distinguish documents, API JSON, and binary data', async () => {
    const edgeone = JSON.parse(await readFile(new URL('../edgeone.json', import.meta.url), 'utf8'))
    const edgeGlobalHeaders = Object.fromEntries(
        edgeone.headers.find(rule => rule.source === '/*').headers
            .map(({ key, value }) => [key, value]),
    )
    for (const [key, value] of Object.entries(TRANSPORT_SECURITY_HEADERS)) {
        assert.equal(edgeGlobalHeaders[key], value, `${key} must match EdgeOne`)
        assert.equal(DOCUMENT_SECURITY_HEADERS[key], value, `${key} must match documents`)
        assert.equal(API_SECURITY_HEADERS[key], value, `${key} must match API JSON`)
        assert.equal(BINARY_SECURITY_HEADERS[key], value, `${key} must match binary responses`)
    }
    assert.equal(
        edgeGlobalHeaders['Referrer-Policy'],
        DOCUMENT_SECURITY_HEADERS['Referrer-Policy'],
    )
    assert.equal(
        DOCUMENT_SECURITY_HEADERS['Strict-Transport-Security'],
        'max-age=31536000; includeSubDomains',
    )
    assert.match(DOCUMENT_SECURITY_HEADERS['Content-Security-Policy'], /script-src 'self'/u)
    assert.doesNotMatch(
        DOCUMENT_SECURITY_HEADERS['Content-Security-Policy'],
        /script-src[^;]*unsafe-inline/u,
    )
    for (const directive of [
        "default-src 'self'",
        "script-src 'self'",
        "object-src 'none'",
        "frame-ancestors 'none'",
        "form-action 'self'",
    ]) {
        assert.ok(
            DOCUMENT_SECURITY_HEADERS['Content-Security-Policy'].split('; ').includes(directive),
            directive,
        )
    }
    assert.equal(DOCUMENT_SECURITY_HEADERS['Referrer-Policy'], 'strict-origin-when-cross-origin')
    assert.equal(DOCUMENT_SECURITY_HEADERS['X-Frame-Options'], 'DENY')
    assert.equal(
        DOCUMENT_SECURITY_HEADERS['Permissions-Policy'],
        'camera=(), microphone=(), geolocation=()',
    )

    const api = apiResponse({ ok: true })
    assert.equal(api.headers.get('content-security-policy'), null)
    assert.equal(api.headers.get('strict-transport-security'), 'max-age=31536000; includeSubDomains')
    assert.equal(api.headers.get('referrer-policy'), API_SECURITY_HEADERS['Referrer-Policy'])
    assert.equal(api.headers.get('x-frame-options'), API_SECURITY_HEADERS['X-Frame-Options'])
    assert.equal(api.headers.get('permissions-policy'), API_SECURITY_HEADERS['Permissions-Policy'])

    const binary = binaryResponse(new Uint8Array([1]), 'image/png')
    assert.equal(binary.headers.get('content-security-policy'), null)
    assert.equal(binary.headers.get('x-content-type-options'), 'nosniff')
    assert.equal(binary.headers.get('referrer-policy'), BINARY_SECURITY_HEADERS['Referrer-Policy'])
    assert.equal(binary.headers.get('x-frame-options'), null)
    assert.equal(binary.headers.get('permissions-policy'), null)
})
