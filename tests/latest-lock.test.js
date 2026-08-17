import assert from 'node:assert/strict'
import test from 'node:test'
import { Worker } from 'node:worker_threads'
import { MemoryStore } from '../server/storage.js'

function serializedError(error) {
  return {
    message: String(error?.message || error),
    name: error?.name,
    code: error?.code,
    statusCode: error?.statusCode,
  }
}

test('latest view lock serializes isolated Function workers beyond 100ms', async () => {
  const data = new MemoryStore()
  const workers = [0, 1].map(
    () => new Worker(new URL('./fixtures/latest-lock-worker.js', import.meta.url)),
  )
  const order = []
  let active = 0
  let maxActive = 0
  let firstEnteredResolve
  const firstEntered = new Promise(resolve => {
    firstEnteredResolve = resolve
  })
  let done = 0
  let completedResolve
  let completedReject
  const completed = new Promise((resolve, reject) => {
    completedResolve = resolve
    completedReject = reject
  })

  workers.forEach((worker, index) => {
    worker.on('message', async (message) => {
      if (message.type === 'rpc') {
        try {
          const value = await data[message.method](...message.args)
          worker.postMessage({ type: 'rpc-result', id: message.id, ok: true, value })
        } catch (error) {
          worker.postMessage({
            type: 'rpc-result',
            id: message.id,
            ok: false,
            error: serializedError(error),
          })
        }
        return
      }
      if (message.type === 'entered') {
        active += 1
        maxActive = Math.max(maxActive, active)
        order.push(`enter-${index}`)
        if (index === 0) firstEnteredResolve()
      } else if (message.type === 'left') {
        order.push(`left-${index}`)
        active -= 1
      } else if (message.type === 'done') {
        done += 1
        if (done === workers.length) completedResolve()
      } else if (message.type === 'failed') {
        completedReject(new Error(message.error))
      }
    })
    worker.on('error', completedReject)
  })

  try {
    workers[0].postMessage({ type: 'start', holdMs: 250 })
    await firstEntered
    workers[1].postMessage({ type: 'start', holdMs: 0 })
    await completed
    assert.equal(maxActive, 1)
    assert.deepEqual(order, ['enter-0', 'left-0', 'enter-1', 'left-1'])
  } finally {
    await Promise.all(workers.map(worker => worker.terminate()))
  }
})
