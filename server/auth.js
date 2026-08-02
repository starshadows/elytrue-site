import { randomUUID } from 'node:crypto'
import {
    decryptEmail,
    encryptEmail,
    hashPassword,
    keyedDigest,
    randomToken,
    sha256,
    verifyPassword,
} from './crypto.js'
import { cookie, httpError, parseCookies, publicUser } from './http.js'
import { getJSON, isPreconditionFailure } from './storage.js'
import {
    normalizeEmail,
    normalizeUsername,
    validateEmail,
    validatePassword,
    validateUsername,
} from '../shared/validation.js'

const SESSION_SECONDS = 30 * 24 * 60 * 60

export function getAppSecret(env) {
    const secret = env?.ELYTRUE_APP_SECRET
    if (!secret || String(secret).length < 32) {
        throw httpError(503, '服务尚未完成安全配置')
    }
    return String(secret)
}

function usernameIndexKey(name) {
    return `indexes/users/name/${sha256(normalizeUsername(name))}.json`
}

function emailIndexKey(secret, email) {
    return `indexes/users/email/${keyedDigest(secret, normalizeEmail(email), 'email-index')}.json`
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
    return getJSON(data, `users/${index.userId}.json`)
}

export async function findUserById(data, userId) {
    if (!/^[a-f0-9-]{36}$/iu.test(String(userId || ''))) return null
    return getJSON(data, `users/${userId}.json`)
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
    let nameReserved = false
    let emailReserved = false

    try {
        await data.setJSON(nameKey, { userId }, { onlyIfNew: true })
        nameReserved = true
        await data.setJSON(emailKey, { userId }, { onlyIfNew: true })
        emailReserved = true

        const now = Date.now()
        const user = {
            id: userId,
            name: normalizedName,
            emailHash: keyedDigest(secret, normalizedEmail, 'email-index'),
            emailCipher: encryptEmail(secret, normalizedEmail),
            passwordHash: await hashPassword(password),
            avatarKey: '',
            role: 'user',
            sessionVersion: 1,
            createdAt: now,
            updatedAt: now,
        }
        await data.setJSON(`users/${userId}.json`, user, { onlyIfNew: true })
        return user
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

export async function createSession(data, user, request) {
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
    await data.setJSON(`sessions/${tokenHash}.json`, session, { onlyIfNew: true })
    const secure = new URL(request.url).protocol === 'https:'
    return {
        session,
        cookies: [
            cookie('elytrue_session', token, { maxAge: SESSION_SECONDS, secure }),
        ],
    }
}

export async function getSession(data, request, { slide = true } = {}) {
    const cookies = parseCookies(request)
    const token = cookies.elytrue_session
    if (!token) return null
    const tokenHash = sha256(token)
    const session = await getJSON(data, `sessions/${tokenHash}.json`)
    if (!session || session.expiresAt <= Date.now()) {
        if (session) await data.delete(`sessions/${tokenHash}.json`).catch(() => {})
        return null
    }
    const user = await findUserById(data, session.userId)
    if (!user || user.sessionVersion !== session.version) {
        await data.delete(`sessions/${tokenHash}.json`).catch(() => {})
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
        const secure = new URL(request.url).protocol === 'https:'
        refreshCookies = [
            cookie('elytrue_session', token, { maxAge: SESSION_SECONDS, secure }),
        ]
    }
    if (shouldPersist) await data.setJSON(`sessions/${tokenHash}.json`, session)
    return { session, user, tokenHash, cookies, refreshCookies }
}

export async function requireSession(data, request, { csrf = true } = {}) {
    const auth = await getSession(data, request)
    if (!auth) throw httpError(401, '请先登录')
    if (csrf) {
        const csrfHeader = request.headers.get('x-csrf-token') || ''
        if (
            !csrfHeader
            || csrfHeader !== auth.session.csrfToken
            || sha256(csrfHeader) !== auth.session.csrfHash
        ) {
            throw httpError(403, '安全校验失败，请刷新页面后重试')
        }
    }
    return auth
}

export async function destroySession(data, request, auth) {
    if (auth?.tokenHash) await data.delete(`sessions/${auth.tokenHash}.json`).catch(() => {})
    const secure = new URL(request.url).protocol === 'https:'
    return [
        cookie('elytrue_session', '', { maxAge: 0, secure }),
    ]
}

export async function revokeAllSessions(data, user) {
    user.sessionVersion = Number(user.sessionVersion || 0) + 1
    user.updatedAt = Date.now()
    await data.setJSON(`users/${user.id}.json`, user)
    return user
}

export async function updateUser(data, uploads, env, user, updates) {
    const secret = getAppSecret(env)

    // 索引事务:先保存原状态 → 原子认领全部新索引 → 写用户本体 →
    // 成功后删除旧索引;失败只回滚本次认领的新索引,用户本体与旧索引保持不变
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

    if (updates.name !== undefined) {
        const nameError = validateUsername(updates.name)
        if (nameError) throw httpError(400, nameError)
        const nextName = String(updates.name).normalize('NFKC').trim()
        if (normalizeUsername(nextName) !== normalizeUsername(user.name)) {
            oldIndexes.push({ type: 'name', key: usernameIndexKey(user.name) })
            try {
                await data.setJSON(usernameIndexKey(nextName), { userId: user.id }, { onlyIfNew: true })
                claimedKeys.push(usernameIndexKey(nextName))
            } catch (error) {
                if (isPreconditionFailure(error)) throw httpError(409, '用户名已被使用')
                throw error
            }
            user.name = nextName
        }
    }

    if (updates.email !== undefined) {
        const emailError = validateEmail(updates.email)
        if (emailError) throw httpError(400, emailError)
        const nextEmail = normalizeEmail(updates.email)
        const nextHash = keyedDigest(secret, nextEmail, 'email-index')
        if (nextHash !== user.emailHash) {
            oldIndexes.push({ type: 'email', key: `indexes/users/email/${user.emailHash}.json` })
            try {
                await data.setJSON(emailIndexKey(secret, nextEmail), { userId: user.id }, { onlyIfNew: true })
                claimedKeys.push(emailIndexKey(secret, nextEmail))
            } catch (error) {
                if (isPreconditionFailure(error)) {
                    await rollback()
                    throw httpError(409, '邮箱已被注册')
                }
                await rollback()
                throw error
            }
            user.emailHash = nextHash
            user.emailCipher = encryptEmail(secret, nextEmail)
        }
    }

    if (updates.password !== undefined) {
        const passwordError = validatePassword(updates.password)
        if (passwordError) throw httpError(400, passwordError)
        user.passwordHash = await hashPassword(updates.password)
        user.sessionVersion = Number(user.sessionVersion || 0) + 1
    }

    if (updates.avatarKey !== undefined) user.avatarKey = updates.avatarKey
    user.updatedAt = Date.now()

    try {
        await data.setJSON(`users/${user.id}.json`, user)
    } catch (error) {
        await rollback()
        throw error
    }

    // 本体写入成功后再删旧索引;删除失败不影响结果,但记录结构化日志供修复
    for (const old of oldIndexes) {
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
    return user
}

export function privateProfile(user, env) {
    const profile = publicUser(user)
    profile.email = decryptEmail(getAppSecret(env), user.emailCipher)
    return profile
}
