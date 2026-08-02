import assert from 'node:assert/strict'
import { after, before, describe, it } from 'node:test'
import { getFromAddress, sendPasswordResetEmail } from '../server/email.js'

const env = {
    RESEND_API_KEY: 're_test_key',
    PUBLIC_SITE_URL: 'https://preview.elytrue.test',
}

describe('password reset email provider', () => {
    const originalFetch = globalThis.fetch
    let capturedRequest
    let responsePayload

    before(() => {
        globalThis.fetch = async (_url, init) => {
            capturedRequest = JSON.parse(init.body)
            return new Response(JSON.stringify(responsePayload), {
                status: responsePayload === null ? 500 : 200,
                headers: { 'Content-Type': 'application/json' },
            })
        }
    })

    after(() => {
        globalThis.fetch = originalFetch
    })

    it('returns a structured failure when RESEND_API_KEY is missing', async () => {
        const result = await sendPasswordResetEmail({ PUBLIC_SITE_URL: env.PUBLIC_SITE_URL }, {
            email: 'owner@example.com',
            username: '星花旅人',
            token: 'secret-token',
        })
        assert.equal(result.ok, false)
        assert.match(result.error, /RESEND_API_KEY/u)
        assert.equal(capturedRequest, undefined)
    })

    it('rejects an invalid RESEND_FROM_EMAIL without calling Resend', async () => {
        const result = await sendPasswordResetEmail({
            RESEND_API_KEY: env.RESEND_API_KEY,
            RESEND_FROM_EMAIL: 'not-an-email',
        }, { email: 'a@b.com', username: 'u', token: 't' })
        assert.equal(result.ok, false)
        assert.match(result.error, /RESEND_FROM_EMAIL/u)
        assert.equal(capturedRequest, undefined)
    })

    it('sends with configurable from and returns the email id on success', async () => {
        responsePayload = { id: 'resend-email-123' }
        const result = await sendPasswordResetEmail({
            ...env,
            RESEND_FROM_EMAIL: 'hello@mail.elytrue.com',
            RESEND_FROM_NAME: '星花札记客服',
        }, {
            email: 'owner@example.com',
            username: '星花旅人',
            token: 'a-token',
        })
        assert.equal(result.ok, true)
        assert.equal(result.emailId, 'resend-email-123')
        assert.equal(capturedRequest.from, '星花札记客服 <hello@mail.elytrue.com>')
        assert.equal(capturedRequest.to[0], 'owner@example.com')
        assert.match(capturedRequest.html, /https:\/\/preview\.elytrue\.test\/#resetpassword=a-token/u)
        assert.equal(capturedRequest.html.includes('secret-token'), false)
    })

    it('uses default from address when RESEND_FROM_* are unset', async () => {
        responsePayload = { id: 'resend-email-456' }
        const result = await sendPasswordResetEmail(env, {
            email: 'owner@example.com',
            username: '星花旅人',
            token: 'a-token',
        })
        assert.equal(result.ok, true)
        assert.equal(capturedRequest.from, '星花札记 <noreply@mail.elytrue.com>')
    })

    it('returns status and truncated body on non-2xx', async () => {
        responsePayload = null
        globalThis.fetch = async (_url, init) => {
            capturedRequest = JSON.parse(init.body)
            return new Response('domain is not verified', { status: 403 })
        }
        const result = await sendPasswordResetEmail(env, {
            email: 'owner@example.com',
            username: '星花旅人',
            token: 'a-token',
        })
        assert.equal(result.ok, false)
        assert.equal(result.status, 403)
        assert.equal(result.error, 'domain is not verified')
    })

    it('does not throw on network errors, returns them as result', async () => {
        globalThis.fetch = async () => {
            throw new Error('network down')
        }
        const result = await sendPasswordResetEmail(env, {
            email: 'owner@example.com',
            username: '星花旅人',
            token: 'a-token',
        })
        assert.equal(result.ok, false)
        assert.match(result.error, /network down/u)
    })
})

describe('from address validation', () => {
    it('formats name and email', () => {
        assert.equal(getFromAddress({ RESEND_FROM_NAME: '名', RESEND_FROM_EMAIL: 'a@b.com' }), '名 <a@b.com>')
    })

    it('falls back to defaults', () => {
        assert.equal(getFromAddress({}), '星花札记 <noreply@mail.elytrue.com>')
    })

    it('throws for invalid email', () => {
        assert.throws(() => getFromAddress({ RESEND_FROM_EMAIL: 'nope' }))
    })
})
