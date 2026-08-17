import { randomUUID } from 'node:crypto'
import { blobKeys } from './domain/blob-keys.js'
import { httpError } from './http.js'
import { getJSON, isPreconditionFailure } from './storage.js'

const UID_SCHEMA_VERSION = 1
const MAX_UID_CLAIM_ATTEMPTS = 2000

function validUid(value) {
    return Number.isSafeInteger(value) && value > 0
}

export async function ensureUserUidSchema(data, hasExistingUsers) {
    const current = await getJSON(data, blobKeys.userUidSchema)
    if (current?.status === 'ready' && current.version === UID_SCHEMA_VERSION) return current
    if (current) throw httpError(503, '用户 UID 数据需要修复后才能注册')
    if (hasExistingUsers) throw httpError(503, '用户 UID 迁移尚未完成，请稍后再试')

    const schema = {
        version: UID_SCHEMA_VERSION,
        status: 'ready',
        initializedAt: Date.now(),
        source: 'empty-store-bootstrap',
    }
    try {
        await data.setJSON(blobKeys.userUidSchema, schema, { onlyIfNew: true })
    } catch (error) {
        if (!isPreconditionFailure(error)) throw error
    }
    const initialized = await getJSON(data, blobKeys.userUidSchema)
    if (initialized?.status !== 'ready' || initialized.version !== UID_SCHEMA_VERSION) {
        throw httpError(503, '用户 UID 初始化失败，请稍后再试')
    }
    return initialized
}

export async function claimUserUid(data, userId, options = {}) {
    const reservationId = options.reservationId || randomUUID()
    const hintValue = Number((await getJSON(data, blobKeys.userUidHint))?.value || 0)
    let uid = validUid(hintValue) ? hintValue + 1 : 1

    for (let attempt = 0; attempt < MAX_UID_CLAIM_ATTEMPTS; attempt += 1) {
        const key = blobKeys.userUid(uid)
        const seat = {
            uid,
            userId,
            reservationId,
            status: 'reserved',
            createdAt: Date.now(),
        }
        try {
            await data.setJSON(key, seat, { onlyIfNew: true })
        } catch (error) {
            if (!isPreconditionFailure(error)) throw error
            uid += 1
            continue
        }

        const claimed = await getJSON(data, key)
        if (claimed?.userId !== userId || claimed?.reservationId !== reservationId) {
            uid += 1
            continue
        }

        let committed = false
        return {
            uid,
            reservationId,
            async commit() {
                if (committed) return
                const current = await getJSON(data, key)
                if (current?.userId !== userId || current?.reservationId !== reservationId) {
                    throw new Error('user UID reservation ownership changed before commit')
                }
                try {
                    await data.setJSON(key, {
                        ...current,
                        status: 'committed',
                        committedAt: Date.now(),
                    })
                } catch (error) {
                    const persisted = await getJSON(data, key).catch(() => null)
                    if (
                        persisted?.userId !== userId
                        || persisted?.reservationId !== reservationId
                        || persisted?.status !== 'committed'
                    ) throw error
                }
                const persisted = await getJSON(data, key)
                if (
                    persisted?.userId !== userId
                    || persisted?.reservationId !== reservationId
                    || persisted?.status !== 'committed'
                ) {
                    throw new Error('user UID reservation could not be committed')
                }
                committed = true
                const hint = await getJSON(data, blobKeys.userUidHint).catch(() => null)
                if (!validUid(hint?.value) || hint.value < uid) {
                    await data.setJSON(blobKeys.userUidHint, {
                        value: uid,
                        updatedAt: Date.now(),
                    }).catch(() => {})
                }
            },
            async rollback() {
                if (committed) return
                const persistedUser = await getJSON(data, blobKeys.user(userId)).catch(() => null)
                if (persistedUser?.uid === uid) return
                const current = await getJSON(data, key).catch(() => null)
                if (current?.userId === userId && current?.reservationId === reservationId) {
                    await data.delete(key)
                }
            },
        }
    }
    throw httpError(500, '用户 UID 分配失败，请稍后再试')
}
