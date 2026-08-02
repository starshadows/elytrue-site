import assert from 'node:assert/strict'
import { afterEach, describe, test } from 'node:test'
import { ApiClient, ApiError } from '../../src/lib/api-client'

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

describe('typed API client', () => {
  test('uses same-origin credentials, JSON, CSRF, and refreshes the token', async () => {
    let request: { input: URL | RequestInfo; init?: RequestInit } | undefined
    let csrf = 'csrf-before'
    globalThis.fetch = async (input, init) => {
      request = { input, init }
      return Response.json({
        code: 1,
        message: 'ok',
        data: { csrfToken: 'csrf-after', value: 7 },
      })
    }
    const client = new ApiClient('/api/', {
      origin: 'https://elytrue.com',
      getCsrfToken: () => csrf,
      setCsrfToken: (value) => {
        csrf = value
      },
    })

    const result = await client.request<{ csrfToken: string; value: number }>(
      'comments/post',
      { method: 'POST', body: { comment: 'hello' } },
    )

    assert.equal(
      String(request?.input),
      'https://elytrue.com/api/comments/post',
    )
    assert.equal(request?.init?.credentials, 'include')
    assert.equal(
      new Headers(request?.init?.headers).get('X-CSRF-Token'),
      'csrf-before',
    )
    assert.equal(
      new Headers(request?.init?.headers).get('Content-Type'),
      'application/json',
    )
    assert.equal(request?.init?.body, '{"comment":"hello"}')
    assert.equal(result.data.value, 7)
    assert.equal(csrf, 'csrf-after')
  })

  test('does not attach CSRF or a body to safe requests', async () => {
    let requestInit: RequestInit | undefined
    globalThis.fetch = async (_input, init) => {
      requestInit = init
      return Response.json({ code: 1, message: 'ok', data: [] })
    }
    const client = new ApiClient('/api', {
      origin: 'https://elytrue.com',
      getCsrfToken: () => 'secret',
    })

    await client.request('comments', { body: { ignored: true } })

    assert.equal(new Headers(requestInit?.headers).has('X-CSRF-Token'), false)
    assert.equal(requestInit?.body, undefined)
  })

  test('clears authentication and preserves the API envelope on 401', async () => {
    let unauthorized = 0
    globalThis.fetch = async () =>
      Response.json(
        { code: 401, message: '登录状态已失效', data: { reason: 'expired' } },
        { status: 401 },
      )
    const client = new ApiClient('/api/', {
      origin: 'https://elytrue.com',
      onUnauthorized: () => {
        unauthorized += 1
      },
    })

    await assert.rejects(
      () => client.request('user/me'),
      (error: unknown) => {
        assert.ok(error instanceof ApiError)
        assert.equal(error.status, 401)
        assert.equal(error.code, 401)
        assert.deepEqual(error.data, { reason: 'expired' })
        return true
      },
    )
    assert.equal(unauthorized, 1)
  })

  test('aborts at the configured timeout with a TimeoutError', async () => {
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          {
            once: true,
          },
        )
      })
    const client = new ApiClient('/api/', {
      origin: 'https://elytrue.com',
      timeoutMs: 10,
    })

    await assert.rejects(
      () => client.request('health'),
      (error: unknown) =>
        error instanceof DOMException && error.name === 'TimeoutError',
    )
  })

  test('combines a caller AbortSignal with the timeout signal', async () => {
    const caller = new AbortController()
    globalThis.fetch = async (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener(
          'abort',
          () => reject(init.signal?.reason),
          {
            once: true,
          },
        )
        caller.abort(new DOMException('cancelled', 'AbortError'))
      })
    const client = new ApiClient('/api/', {
      origin: 'https://elytrue.com',
      timeoutMs: 5_000,
    })

    await assert.rejects(
      () => client.request('comments', { signal: caller.signal }),
      (error: unknown) =>
        error instanceof DOMException && error.name === 'AbortError',
    )
  })
})
