import { randomUUID } from 'node:crypto'
import {
    decryptEmail,
    encryptEmail,
    generateRecoveryKey,
    hashPassword,
    hashRecoveryKey,
    keyedDigest,
    randomToken,
    sha256,
    verifyPassword,
} from './crypto.js'
import { cookie, httpError, isSecureRequest, parseCookies, publicUser } from './http.js'
import { getJSON, isPreconditionFailure, listAll } from './storage.js'
import { blobKeys, blobPrefixes } from './domain/blob-keys.js'
import {
    normalizeEmail,
    normalizeUsername,
    validateEmail,
    validatePassword,
    validateUsername,
} from '../shared/validation.js'

const SESSION_SECONDS = 30 * 24 * 60 * 60
const adminUserIds = new WeakMap()

export function getAppSecret(env) {
    const secret = env?.ELYTRUE_APP_SECRET
    if (!secret || String(secret).length < 32) {
        throw httpError(503, '服务尚未完成安全配置')
    }
    return String(secret)
}

function usernameIndexKey(name) {
    return blobKeys.userNameIndex(sha256(normalizeUsername(name)))
}

function emailIndexKey(secret, email) {
    return blobKeys.userEmailIndex(keyedDigest(secret, normalizeEmail(email), 'email-index'))
}

async function claimUniqueIndex(data, key, userId, conflictMessage) {
    const existing = await getJSON(data, key)
    if (existing) throw httpError(409, conflictMessage)

    try {
        await data.setJSON(key, { userId }, { onlyIfNew: true })
    } catch (error) {
        if (isPreconditionFailure(error)) throw httpError(409, conflictMessage)
        throw error
    }

    // 部分对象存储代理可能把 If-None-Match 冲突表现为成功但不写入。
    // 强一致回读必须确认索引确实属于本次注册，不能只依赖 SDK 抛错。
    const claimed = await getJSON(data, key)
    if (claimed?.userId !== userId) throw httpError(409, conflictMessage)
}

/** @param {import('./types.js').ServerTiming | null} timing */
async function applyAdminMarker(data, user, timing = null) {
    if (!user) return user
    if (user.role === 'admin') {
        adminUserIds.set(data, user.id)
        return user
    }
    const cachedAdminId = adminUserIds.get(data)
    if (cachedAdminId) {
        return cachedAdminId === user.id ? { ...user, role: 'admin' } : user
    }
    const marker = timing
        ? await timing.measure('adminMarker', () =>
            getJSON(data, blobKeys.adminBootstrapClosed))
        : await getJSON(data, blobKeys.adminBootstrapClosed)
    if (marker?.userId) adminUserIds.set(data, marker.userId)
    return marker?.userId === user.id ? { ...user, role: 'admin' } : user
}

export async function findUserByIdentifier(data, env, identifier) {
    const secret = getAppSecret(env)
    const normalized = String(identifier ?? '').normalize('NFKC').trim()
    if (!normalized) return null
    const indexKey = normalized.includes('@')
        ? emailIndexKey(secret, normalized)
        : usernameIndexKey(normalized)
    const index = await getJSON(data, indexKey)
    if (!index?.userId) return null
    return applyAdminMarker(data, await getJSON(data, blobKeys.user(index.userId)))
}

/** @param {{timing?: import('./types.js').ServerTiming | null}} [options] */
export async function findUserById(data, userId, options = {}) {
    if (!/^[a-f0-9-]{36}$/iu.test(String(userId || ''))) return null
    const user = options.timing
        ? await options.timing.measure('user', () =>
            getJSON(data, blobKeys.user(userId)))
        : await getJSON(data, blobKeys.user(userId))
    return applyAdminMarker(
        data,
        user,
        options.timing,
    )
}

async function cleanupUserMutationClaim(data, userId, version, reservationId) {
    const key = blobKeys.recoveryKeyClaim(userId, version)
    let lastError
    for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
            const claim = await getJSON(data, key)
            if (!claim || claim.reservationId !== reservationId) return
            await data.delete(key)
            const remaining = await getJSON(data, key)
            if (!remaining || remaining.reservationId !== reservationId) return
            lastError = new Error('claim remained after delete')
        } catch (error) {
            lastError = error
        }
        await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)))
    }
    console.error(JSON.stringify({
        event: 'user_mutation_claim_cleanup_failed',
        userId,
        version,
        error: String(lastError?.message || lastError).slice(0, 300),
    }))
}

export async function beginUserMutation(data, user, options = {}) {
    const version = Number(user.recoveryKeyVersion || 0)
    const reservationId = randomToken(16)
    const claimKey = blobKeys.recoveryKeyClaim(user.id, version)
    const conflict = () => httpError(
        options.conflictStatus || 409,
        options.conflictMessage || '账号资料正在更新，请稍后重试',
    )
    let claimed = false
    let released = false
    const release = async () => {
        if (released || !claimed) return
        released = true
        await cleanupUserMutationClaim(data, user.id, version, reservationId)
    }
    try {
        try {
            claimed = true
            await data.setJSON(claimKey, {
                reservationId,
                claimedAt: Date.now(),
                type: options.claimType || 'user-mutation',
            }, { onlyIfNew: true })
        } catch (error) {
            if (isPreconditionFailure(error)) throw conflict()
            throw error
        }
        const claim = await getJSON(data, claimKey)
        if (claim?.reservationId !== reservationId) throw conflict()

        const current = await getJSON(data, blobKeys.user(user.id))
        if (!current || Number(current.recoveryKeyVersion || 0) !== version) {
            throw conflict()
        }
        let committed = false
        return {
            current,
            reservationId,
            async commit(mutate) {
                if (committed) throw new Error('user mutation already committed')
                const result = await mutate(current)
                current.recoveryKeyVersion = version + 1
                current.lastUserMutationId = reservationId
                current.updatedAt = Date.now()

                try {
                    await data.setJSON(blobKeys.user(user.id), current)
                } catch (error) {
                    let persisted
                    try {
                        persisted = await getJSON(data, blobKeys.user(user.id))
                    } catch (reconciliationError) {
                        error.userWriteAmbiguous = true
                        error.reconciliationError = reconciliationError
                        throw error
                    }
                    if (
                        persisted?.lastUserMutationId === reservationId
                        && Number(persisted.recoveryKeyVersion || 0) === version + 1
                    ) {
                        committed = true
                        return { result, user: persisted }
                    }
                    throw error
                }
                committed = true
                return { result, user: current }
            },
            release,
        }
    } catch (error) {
        await release()
        throw error
    }
}

export async function mutateUserRecord(data, user, mutate, options = {}) {
    const mutation = await beginUserMutation(data, user, options)
    try {
        return await mutation.commit(mutate)
    } finally {
        await mutation.release()
    }
}

async function cleanupOldUserIndexes(data, userId, oldIndexes) {
    for (const old of oldIndexes) {
        let current
        try {
            current = await getJSON(data, old.key)
        } catch (error) {
            console.error(JSON.stringify({
                event: 'user_old_index_read_failed',
                userId,
                indexType: old.type,
                key: old.key,
                error: String(error?.message || error).slice(0, 300),
            }))
            continue
        }
        if (!current) continue
        if (String(current.userId) !== String(userId)) {
            console.error(JSON.stringify({
                event: 'user_old_index_not_owned',
                userId,
                indexType: old.type,
                key: old.key,
                indexUserId: current.userId,
            }))
            continue
        }
        await data.delete(old.key).catch(error => {
            console.error(JSON.stringify({
                event: 'user_old_index_delete_failed',
                userId,
                indexType: old.type,
                key: old.key,
                error: String(error?.message || error).slice(0, 300),
            }))
        })
    }
}

export async function prepareUserUpdate(data, env, user, updates, deps = {}) {
    const secret = getAppSecret(env)
    const hashPasswordImpl = deps.hashPassword || hashPassword
    const next = { passwordHash: user.passwordHash, sessionVersion: user.sessionVersion }
    const oldIndexes = []

    // Complete all CPU-only validation before claiming indexes or writing an image.
    if (updates.name !== undefined) {
        const nameError = validateUsername(updates.name)
        if (nameError) throw httpError(400, nameError)
        next.name = String(updates.name).normalize('NFKC').trim()
        if (normalizeUsername(next.name) !== normalizeUsername(user.name)) {
            next.nameChanged = true
            next.nameIndexKey = usernameIndexKey(next.name)
            oldIndexes.push({ type: 'name', key: usernameIndexKey(user.name) })
        }
    }

    if (updates.email !== undefined) {
        const emailError = validateEmail(updates.email)
        if (emailError) throw httpError(400, emailError)
        next.email = normalizeEmail(updates.email)
        next.emailHash = keyedDigest(secret, next.email, 'email-index')
        if (next.emailHash !== user.emailHash) {
            next.emailChanged = true
            next.emailIndexKey = emailIndexKey(secret, next.email)
            oldIndexes.push({ type: 'email', key: blobKeys.userEmailIndex(user.emailHash) })
        }
    }

    if (updates.password !== undefined) {
        const passwordError = validatePassword(updates.password)
        if (passwordError) throw httpError(400, passwordError)
        next.passwordHash = await hashPasswordImpl(updates.password)
        next.sessionVersion = Number(user.sessionVersion || 0) + 1
    }

    if (updates.avatarKey !== undefined) next.avatarKey = updates.avatarKey

    const mutation = await beginUserMutation(data, user, { claimType: 'profile-update' })
    const claimedKeys = []
    let committed = false
    let closed = false
    const rollbackIndexes = async () => {
        for (const key of claimedKeys) {
            const index = await getJSON(data, key).catch(() => null)
            if (index?.userId !== user.id) continue
            await data.delete(key).catch(error => {
                console.error(JSON.stringify({
                    event: 'user_index_claim_rollback_failed',
                    userId: user.id,
                    key,
                    error: String(error?.message || error).slice(0, 300),
                }))
            })
        }
    }
    const rollback = async () => {
        if (closed) return
        closed = true
        if (!committed) await rollbackIndexes()
        await mutation.release()
    }
    const claimIndex = async (key, conflictMessage) => {
        claimedKeys.push(key)
        let writeError
        try {
            await data.setJSON(key, { userId: user.id }, { onlyIfNew: true })
        } catch (error) {
            if (isPreconditionFailure(error)) throw httpError(409, conflictMessage)
            writeError = error
        }
        let index
        try {
            index = await getJSON(data, key)
        } catch {
            throw writeError || new Error('unable to verify user index claim')
        }
        if (index?.userId !== user.id) {
            if (index) throw httpError(409, conflictMessage)
            throw writeError || new Error('user index claim was not persisted')
        }
    }

    try {
        if (next.nameChanged) {
            await claimIndex(next.nameIndexKey, '用户名已被使用')
        }
        if (next.emailChanged) {
            await claimIndex(next.emailIndexKey, '邮箱已被注册')
        }
    } catch (error) {
        await rollback()
        throw error
    }

    return {
        async commit(extraUpdates = {}) {
            if (closed) throw new Error('user update transaction is closed')
            try {
                const mutationResult = await mutation.commit(current => {
                    if (next.nameChanged) current.name = next.name
                    if (next.emailChanged) {
                        current.emailHash = next.emailHash
                        current.emailCipher = encryptEmail(secret, next.email)
                    }
                    current.passwordHash = next.passwordHash
                    current.sessionVersion = next.sessionVersion
                    const avatarKey = extraUpdates.avatarKey !== undefined
                        ? extraUpdates.avatarKey
                        : next.avatarKey
                    if (avatarKey !== undefined) current.avatarKey = avatarKey
                    if (extraUpdates.avatarOperationId !== undefined) {
                        current.lastAvatarOperationId = extraUpdates.avatarOperationId
                    }
                })
                committed = true
                await cleanupOldUserIndexes(data, user.id, oldIndexes)
                return mutationResult.user
            } catch (error) {
                if (!error?.userWriteAmbiguous) await rollbackIndexes()
                throw error
            } finally {
                closed = true
                await mutation.release()
            }
        },
        claimedIndexKeys: [...claimedKeys],
        oldIndexKeys: oldIndexes.map(index => index.key),
        rollback,
    }
}

export async function registerUser(data, env, { name, email, password }) {
    const nameError = validateUsername(name)
    const emailError = validateEmail(email)
    const passwordError = validatePassword(password)
    if (nameError || emailError || passwordError) {
        throw httpError(400, nameError || emailError || passwordError)
    }

    const secret = getAppSecret(env)
    const normalizedName = String(name).normalize('NFKC').trim()
    const normalizedEmail = normalizeEmail(email)
    const userId = randomUUID()
    const nameKey = usernameIndexKey(normalizedName)
    const emailKey = emailIndexKey(secret, normalizedEmail)
    // 旧仓库可能有用户但没有管理员关闭标记；强一致列举可避免把后来注册者误升为管理员。
    // 并发空仓库注册最终再由 onlyIfNew 标记选出唯一管理员。
    const adminMarker = await getJSON(data, blobKeys.adminBootstrapClosed)
    const hasExistingUsers = adminMarker
        ? true
        : (await listAll(data, blobPrefixes.users, 1)).length > 0
    const canBecomeFirstAdmin = !adminMarker && !hasExistingUsers
    let nameReserved = false
    let emailReserved = false

    try {
        await claimUniqueIndex(data, nameKey, userId, '用户名已被使用')
        nameReserved = true
        await claimUniqueIndex(data, emailKey, userId, '邮箱已被注册')
        emailReserved = true

        const now = Date.now()
        const recoveryKey = generateRecoveryKey()
        const user = {
            id: userId,
            name: normalizedName,
            emailHash: keyedDigest(secret, normalizedEmail, 'email-index'),
            emailCipher: encryptEmail(secret, normalizedEmail),
            passwordHash: await hashPassword(password),
            recoveryKeyHash: await hashRecoveryKey(recoveryKey),
            recoveryKeyCreatedAt: now,
            recoveryKeyVersion: 1,
            avatarKey: '',
            role: 'user',
            sessionVersion: 1,
            createdAt: now,
            updatedAt: now,
        }
        await data.setJSON(blobKeys.user(userId), user, { onlyIfNew: true })

        if (canBecomeFirstAdmin) {
            try {
                await data.setJSON(
                    blobKeys.adminBootstrapClosed,
                    {
                        userId,
                        closedAt: now,
                        automatic: true,
                    },
                    { onlyIfNew: true },
                )
                user.role = 'admin'
                const mutation = await mutateUserRecord(data, user, current => {
                    current.role = 'admin'
                }, { claimType: 'admin-bootstrap' })
                Object.assign(user, mutation.user)
            } catch (error) {
                if (!isPreconditionFailure(error)) {
                    console.error(
                        JSON.stringify({
                            event: 'first_admin_assignment_failed',
                            userId,
                            error: error instanceof Error ? error.message : String(error),
                        }),
                    )
                }
            }
        }

        return { user, recoveryKey }
    } catch (error) {
        const conflictMessage = !nameReserved
            ? '用户名已被使用'
            : !emailReserved
                ? '邮箱已被注册'
                : '账号创建失败'
        if (emailReserved) await data.delete(emailKey).catch(() => {})
        if (nameReserved) await data.delete(nameKey).catch(() => {})
        if (isPreconditionFailure(error)) {
            throw httpError(409, conflictMessage)
        }
        throw error
    }
}

export async function authenticateUser(data, env, identifier, password) {
    const user = await findUserByIdentifier(data, env, identifier)
    const valid = user && await verifyPassword(password, user.passwordHash)
    if (!valid) throw httpError(401, '用户名、邮箱或密码不正确')
    return user
}

export async function createSession(data, user, request, env = {}) {
    const token = randomToken(32)
    const csrf = randomToken(24)
    const tokenHash = sha256(token)
    const now = Date.now()
    const session = {
        userId: user.id,
        tokenHash,
        csrfToken: csrf,
        csrfHash: sha256(csrf),
        version: user.sessionVersion,
        createdAt: now,
        lastSeenAt: now,
        expiresAt: now + SESSION_SECONDS * 1000,
    }
    await data.setJSON(blobKeys.session(tokenHash), session, { onlyIfNew: true })
    const secure = isSecureRequest(request, env)
    return {
        session,
        cookies: [
            cookie('elytrue_session', token, { maxAge: SESSION_SECONDS, secure }),
        ],
    }
}

/**
 * @param {*} data
 * @param {Request} request
 * @param {{slide?: boolean, env?: Record<string, string | undefined>, timing?: import('./types.js').ServerTiming | null}} [options]
 */
export async function getSession(data, request, options = {}) {
    const { slide = true, env = {}, timing = null } = options
    const cookies = parseCookies(request)
    const token = cookies.elytrue_session
    if (!token) return null
    const tokenHash = sha256(token)
    const session = timing
        ? await timing.measure('session', () =>
            getJSON(data, blobKeys.session(tokenHash)))
        : await getJSON(data, blobKeys.session(tokenHash))
    if (!session || session.expiresAt <= Date.now()) {
        if (session) await data.delete(blobKeys.session(tokenHash)).catch(() => {})
        return null
    }
    const user = await findUserById(data, session.userId, { timing })
    if (!user || user.sessionVersion !== session.version) {
        await data.delete(blobKeys.session(tokenHash)).catch(() => {})
        return null
    }

    let shouldPersist = false
    if (!session.csrfToken || sha256(session.csrfToken) !== session.csrfHash) {
        const legacyCsrf = cookies.elytrue_csrf || ''
        session.csrfToken = legacyCsrf && sha256(legacyCsrf) === session.csrfHash
            ? legacyCsrf
            : randomToken(24)
        session.csrfHash = sha256(session.csrfToken)
        shouldPersist = true
    }

    let refreshCookies = []
    if (slide && Date.now() - session.lastSeenAt > 24 * 60 * 60 * 1000) {
        session.lastSeenAt = Date.now()
        session.expiresAt = Date.now() + SESSION_SECONDS * 1000
        shouldPersist = true
        const secure = isSecureRequest(request, env)
        refreshCookies = [
            cookie('elytrue_session', token, { maxAge: SESSION_SECONDS, secure }),
        ]
    }
    if (shouldPersist) {
        if (timing) {
            await timing.measure('sessionRefresh', () =>
                data.setJSON(blobKeys.session(tokenHash), session))
        } else {
            await data.setJSON(blobKeys.session(tokenHash), session)
        }
    }
    return { session, user, tokenHash, cookies, refreshCookies }
}

export async function requireSession(data, request, { csrf = true, env = {} } = {}) {
    const auth = await getSession(data, request, { env })
    if (!auth) throw httpError(401, '请先登录')
    if (csrf) verifyCsrfToken(auth, request)
    return auth
}

export function verifyCsrfToken(auth, request) {
    const csrfHeader = request.headers.get('x-csrf-token') || ''
    if (
        !csrfHeader
        || csrfHeader !== auth.session.csrfToken
        || sha256(csrfHeader) !== auth.session.csrfHash
    ) {
        throw httpError(403, '安全校验失败，请刷新页面后重试')
    }
}

export async function destroySession(data, request, auth, env = {}) {
    if (auth?.tokenHash) await data.delete(blobKeys.session(auth.tokenHash)).catch(() => {})
    const secure = isSecureRequest(request, env)
    return [
        cookie('elytrue_session', '', { maxAge: 0, secure }),
    ]
}

export async function revokeAllSessions(data, user) {
    const mutation = await mutateUserRecord(data, user, current => {
        current.sessionVersion = Number(current.sessionVersion || 0) + 1
    }, { claimType: 'session-revocation' })
    return mutation.user
}

export async function updateUser(data, uploads, env, user, updates, deps = {}) {
    void uploads
    const prepared = await prepareUserUpdate(data, env, user, updates, deps)
    return prepared.commit()
}

export function privateProfile(user, env) {
    const profile = publicUser(user)
    profile.email = decryptEmail(getAppSecret(env), user.emailCipher)
    profile.hasRecoveryKey = Boolean(user.recoveryKeyHash)
    return profile
}
