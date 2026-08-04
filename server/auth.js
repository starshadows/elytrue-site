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

async function applyAdminMarker(data, user) {
    if (!user) return user
    if (user.role === 'admin') {
        adminUserIds.set(data, user.id)
        return user
    }
    const cachedAdminId = adminUserIds.get(data)
    if (cachedAdminId) {
        return cachedAdminId === user.id ? { ...user, role: 'admin' } : user
    }
    const marker = await getJSON(data, blobKeys.adminBootstrapClosed)
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

export async function findUserById(data, userId) {
    if (!/^[a-f0-9-]{36}$/iu.test(String(userId || ''))) return null
    return applyAdminMarker(data, await getJSON(data, blobKeys.user(userId)))
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

export async function mutateUserRecord(data, user, mutate, options = {}) {
    const version = Number(user.recoveryKeyVersion || 0)
    const reservationId = randomToken(16)
    const claimKey = blobKeys.recoveryKeyClaim(user.id, version)
    const conflict = () => httpError(
        options.conflictStatus || 409,
        options.conflictMessage || '账号资料正在更新，请稍后重试',
    )
    try {
        try {
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
        const result = await mutate(current)
        current.recoveryKeyVersion = version + 1
        current.lastUserMutationId = reservationId
        current.updatedAt = Date.now()

        try {
            await data.setJSON(blobKeys.user(user.id), current)
        } catch (error) {
            const persisted = await getJSON(data, blobKeys.user(user.id)).catch(() => null)
            if (
                persisted?.lastUserMutationId === reservationId
                && Number(persisted.recoveryKeyVersion || 0) === version + 1
            ) {
                return { result, user: persisted }
            }
            throw error
        }
        return { result, user: current }
    } finally {
        await cleanupUserMutationClaim(data, user.id, version, reservationId)
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

export async function getSession(data, request, { slide = true, env = {} } = {}) {
    const cookies = parseCookies(request)
    const token = cookies.elytrue_session
    if (!token) return null
    const tokenHash = sha256(token)
    const session = await getJSON(data, blobKeys.session(tokenHash))
    if (!session || session.expiresAt <= Date.now()) {
        if (session) await data.delete(blobKeys.session(tokenHash)).catch(() => {})
        return null
    }
    const user = await findUserById(data, session.userId)
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
    if (shouldPersist) await data.setJSON(blobKeys.session(tokenHash), session)
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
    const secret = getAppSecret(env)
    const hashPasswordImpl = deps.hashPassword || hashPassword

    // 索引事务:
    //   1. 在任何存储写入前完成全部验证与预计算(用户名/邮箱/密码);
    //   2. 原子认领全部新索引(首个认领后任意异常 → 统一 rollback 本次认领);
    //   3. 写用户本体(失败 → rollback);
    //   4. 删除旧索引前强一致读取并校验归属,防止误删历史重名账号的索引。
    const claimedKeys = []
    const oldIndexes = []
    const rollback = async () => {
        for (const key of claimedKeys) {
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
    const fail = async error => {
        await rollback()
        throw error
    }

    // ---- 1. 预校验与预计算(零写入) ----
    const next = { passwordHash: user.passwordHash, sessionVersion: user.sessionVersion }

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

    // ---- 2. 原子认领全部新索引 ----
    if (next.nameChanged) {
        try {
            await data.setJSON(next.nameIndexKey, { userId: user.id }, { onlyIfNew: true })
            claimedKeys.push(next.nameIndexKey)
        } catch (error) {
            if (isPreconditionFailure(error)) return fail(httpError(409, '用户名已被使用'))
            return fail(error)
        }
    }
    if (next.emailChanged) {
        try {
            await data.setJSON(next.emailIndexKey, { userId: user.id }, { onlyIfNew: true })
            claimedKeys.push(next.emailIndexKey)
        } catch (error) {
            if (isPreconditionFailure(error)) return fail(httpError(409, '邮箱已被注册'))
            return fail(error)
        }
    }

    // ---- 3. 认领用户版本并写本体 ----
    let updatedUser
    try {
        const mutation = await mutateUserRecord(data, user, current => {
            if (next.nameChanged) current.name = next.name
            if (next.emailChanged) {
                current.emailHash = next.emailHash
                current.emailCipher = encryptEmail(secret, next.email)
            }
            current.passwordHash = next.passwordHash
            current.sessionVersion = next.sessionVersion
            if (next.avatarKey !== undefined) current.avatarKey = next.avatarKey
        }, { claimType: 'profile-update' })
        updatedUser = mutation.user
    } catch (error) {
        await rollback()
        throw error
    }

    // ---- 4. 删除旧索引:先强一致校验归属,防止误删历史重名账号的索引 ----
    for (const old of oldIndexes) {
        let current
        try {
            current = await getJSON(data, old.key)
        } catch (error) {
            console.error(JSON.stringify({
                event: 'user_old_index_read_failed',
                userId: user.id,
                indexType: old.type,
                key: old.key,
                error: String(error?.message || error).slice(0, 300),
            }))
            continue
        }
        if (!current) {
            // 旧索引已不存在,无需删除
            continue
        }
        if (String(current.userId) !== String(user.id)) {
            console.error(JSON.stringify({
                event: 'user_old_index_not_owned',
                userId: user.id,
                indexType: old.type,
                key: old.key,
                indexUserId: current.userId,
            }))
            continue
        }
        await data.delete(old.key).catch(error => {
            console.error(JSON.stringify({
                event: 'user_old_index_delete_failed',
                userId: user.id,
                indexType: old.type,
                key: old.key,
                error: String(error?.message || error).slice(0, 300),
            }))
        })
    }
    return updatedUser
}

export function privateProfile(user, env) {
    const profile = publicUser(user)
    profile.email = decryptEmail(getAppSecret(env), user.emailCipher)
    profile.hasRecoveryKey = Boolean(user.recoveryKeyHash)
    return profile
}
