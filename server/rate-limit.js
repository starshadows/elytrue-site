import { sha256 } from './crypto.js'
import { httpError } from './http.js'

const memoryBuckets = new Map()

export function resetMemoryRateLimitsForTests() {
    memoryBuckets.clear()
}

/**
 * @typedef {'register' | 'login' | 'recoverIp' | 'recoverAccount' | 'recoveryKey' |
 * 'comment' | 'upload' | 'like' | 'report' | 'admin' | 'userUpdate' | 'logout' |
 * 'logoutAll' | 'bootstrap' | 'userFind'} RateLimitAction
 */

/** @type {Record<RateLimitAction, readonly [number, number]>} */
const POLICIES = {
    register: [20, 60 * 60],
    login: [12, 15 * 60],
    recoverIp: [5, 60 * 60],
    recoverAccount: [5, 60 * 60],
    recoveryKey: [5, 60 * 60],
    comment: [10, 10 * 60],
    upload: [12, 10 * 60],
    like: [60, 10 * 60],
    report: [10, 60 * 60],
    admin: [30, 10 * 60],
    userUpdate: [30, 10 * 60],
    logout: [30, 10 * 60],
    logoutAll: [10, 60 * 60],
    bootstrap: [5, 60 * 60],
    userFind: [120, 10 * 60],
}

/** @param {RateLimitAction} action @param {string | null} identity */
export async function enforceRateLimit(action, identity) {
    // EdgeOne 未提供客户端 IP 时，不能把所有访客归入同一个 "unknown" 桶，
    // 否则少量注册尝试就会在当前 Cloud Functions 实例内关闭全站注册。
    if (!identity) return

    const [limit, windowSeconds] = POLICIES[action] || [30, 60]
    const bucket = Math.floor(Date.now() / 1000 / windowSeconds)
    const prefix = `rl_${action}_${sha256(identity).slice(0, 24)}_`
    const key = `${prefix}${bucket}`
    const count = memoryBuckets.get(key) || 0
    if (count >= limit) throw httpError(429, '操作过于频繁，请稍后再试')
    memoryBuckets.set(key, count + 1)
    if (memoryBuckets.size > 2000) {
        const activeSuffix = `_${bucket}`
        for (const existingKey of memoryBuckets.keys()) {
            if (!existingKey.endsWith(activeSuffix)) memoryBuckets.delete(existingKey)
        }
    }
}
