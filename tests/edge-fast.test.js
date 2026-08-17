import assert from 'node:assert/strict'
import { describe, test } from 'node:test'
import {
  FAST_HANDLER_BUDGET_MS,
  FAST_HEDGE_DELAY_MS,
  FAST_PREVIOUS_GRACE_MS,
  createPublicFastHandler,
} from '../edge-functions/api/comments/public-fast/index.js'

function card(id) {
  return {
    id,
    number: id,
    displayId: id,
    uid: null,
    sender: '匿名用户',
    avatar: '',
    comment: `message-${id}`,
    image: '',
    replyid: null,
    hidden: false,
    liked: false,
    likes: 0,
    time: id,
  }
}

function snapshot(revision, id = revision) {
  return {
    version: 1,
    items: [card(id)],
    hasMore: false,
    todayCount: 1,
    generatedAt: Date.now(),
    snapshotRevision: revision,
  }
}

function storeWith(reads) {
  const calls = []
  return {
    calls,
    async get(key, options) {
      calls.push({ key, options, startedAt: Date.now() })
      const read = key.endsWith('latest.json') ? reads.current : reads.previous
      if (read?.delay) await new Promise((resolve) => setTimeout(resolve, read.delay))
      if (read?.error) throw read.error
      return read?.value ?? null
    },
  }
}

async function invoke(store, options = {}) {
  const handler = createPublicFastHandler({
    storeFactory: () => store,
    ...options,
  })
  const response = await handler({
    request: new Request('https://elytrue.test/api/comments/public-fast?count=10'),
  })
  return {
    response,
    body: await response.json(),
  }
}

describe('public-fast hedged Edge read', () => {
  test('locks the production hedge, grace, and total budgets', () => {
    assert.equal(FAST_HEDGE_DELAY_MS, 140)
    assert.equal(FAST_PREVIOUS_GRACE_MS, 20)
    assert.equal(FAST_HANDLER_BUDGET_MS, 300)
  })

  test('returns a fast current snapshot without starting previous', async () => {
    const store = storeWith({ current: { value: snapshot(8) } })
    const { response, body } = await invoke(store)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-elytrue-snapshot-source'), 'current')
    assert.match(
      response.headers.get('server-timing'),
      /current;dur=.*selection;dur=.*serialization;dur=.*total;dur=/u,
    )
    assert.equal(body.data.snapshotRevision, 8)
    assert.equal(store.calls.length, 1)
    assert.equal(store.calls[0].options.consistency, 'eventual')
  })

  test('hedges previous and uses the higher revision during grace', async () => {
    const calls = []
    let resolveCurrent
    const store = {
      calls,
      get(key, options) {
        calls.push({ key, options, startedAt: Date.now() })
        if (key.endsWith('latest.json')) {
          return new Promise((resolve) => {
            resolveCurrent = resolve
          })
        }
        setTimeout(() => resolveCurrent(snapshot(8)), 10)
        return Promise.resolve(snapshot(9))
      },
    }
    const { response, body } = await invoke(store)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-elytrue-snapshot-source'), 'previous')
    assert.equal(body.data.snapshotRevision, 9)
    assert.equal(store.calls.length, 2)
    const hedgeDelay = store.calls[1].startedAt - store.calls[0].startedAt
    assert.ok(hedgeDelay >= 125 && hedgeDelay <= 175, hedgeDelay)
  })

  test('returns previous immediately after current is conclusively invalid', async () => {
    const store = storeWith({
      current: { value: { broken: true } },
      previous: { value: snapshot(7) },
    })
    const { response, body } = await invoke(store)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('x-elytrue-snapshot-source'), 'previous')
    assert.equal(body.data.snapshotRevision, 7)
  })

  test('returns 503 for two conclusive invalid snapshots', async () => {
    const store = storeWith({
      current: { value: null },
      previous: { value: { broken: true } },
    })
    const { response } = await invoke(store)
    assert.equal(response.status, 503)
    assert.equal(response.headers.get('cache-control'), 'no-store')
  })

  test('returns 504 when both reads exceed the handler budget', async () => {
    const store = storeWith({
      current: { value: snapshot(8), delay: 500 },
      previous: { value: snapshot(7), delay: 500 },
    })
    const startedAt = Date.now()
    const { response } = await invoke(store)
    assert.equal(response.status, 504)
    assert.ok(Date.now() - startedAt <= 350)
  })
})
