import { parentPort } from 'node:worker_threads'
import { withLatestViewLock } from '../../server/services/comment-view-service.js'

if (!parentPort) throw new Error('latest lock worker requires a parent port')

let sequence = 0
const pending = new Map()

function rpc(method, ...args) {
  const id = sequence++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    parentPort.postMessage({ type: 'rpc', id, method, args })
  })
}

const store = {
  setJSON: (...args) => rpc('setJSON', ...args),
  get: (...args) => rpc('get', ...args),
  delete: (...args) => rpc('delete', ...args),
}

parentPort.on('message', async (message) => {
  if (message.type === 'rpc-result') {
    const request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id)
    if (message.ok) request.resolve(message.value)
    else {
      const error = new Error(message.error?.message || 'store RPC failed')
      Object.assign(error, message.error)
      request.reject(error)
    }
    return
  }
  if (message.type !== 'start') return
  try {
    await withLatestViewLock(store, async () => {
      parentPort.postMessage({ type: 'entered' })
      await new Promise((resolve) => setTimeout(resolve, message.holdMs))
      parentPort.postMessage({ type: 'left' })
    })
    parentPort.postMessage({ type: 'done' })
  } catch (error) {
    parentPort.postMessage({
      type: 'failed',
      error: String(error?.message || error),
    })
  }
})
