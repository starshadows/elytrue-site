import { sha256 } from './crypto.js'
import { httpError } from './http.js'

const memoryBuckets = new Map()

export function resetMemoryRateLimitsForTests() {
    memoryBuckets.clear()
}

const POLICIES = {
    register: [5, 60 * 60],
    login: [12, 15 * 60],
    reset: [5, 60 * 60],
    comment: [10, 10 * 60],
    upload: [12, 10 * 60],
    like: [60, 10 * 60],
    report: [10, 60 * 60],
    admin: [30, 10 * 60],
}

export async function enforceRateLimit(action, identity) {
    const [limit, windowSeconds] = POLICIES[action] || [30, 60]
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
    const prefix = `rl_${action}_${sha256(identity).slice(0, 24)}_`
    const key = `${prefix}${bucket}`
    const kv = globalThis.ELYTRUE_RATE_LIMIT_KV

    let count = 0
    if (kv?.get && kv?.put) {
        count = Number(await kv.get(key, { type: 'text' }) || 0)
        if (count >= limit) throw httpError(429, '操作过于频繁，请稍后再试')
        await kv.put(key, String(count + 1))
        if (kv.list && kv.delete) {
            const stale = await kv.list({ prefix, limit: 20 }).catch(() => null)
            for (const item of stale?.keys || []) {
                if (item.key !== key) await kv.delete(item.key).catch(() => {})
            }
        }
        return
    }

    count = memoryBuckets.get(key) || 0
    if (count >= limit) throw httpError(429, '操作过于频繁，请稍后再试')
    memoryBuckets.set(key, count + 1)
    if (memoryBuckets.size > 2000) {
        const activeSuffix = `_${bucket}`
        for (const existingKey of memoryBuckets.keys()) {
            if (!existingKey.endsWith(activeSuffix)) memoryBuckets.delete(existingKey)
        }
    }
}
