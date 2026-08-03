import { decryptEmail, hashPassword, randomToken, sha256 } from '../crypto.js'
import { sendPasswordResetEmail } from '../email.js'
import { findUserById, findUserByIdentifier, getAppSecret } from '../auth.js'
import { httpError } from '../http.js'
import { createUserRepository } from '../repositories/user-repository.js'
import { isPreconditionFailure } from '../storage.js'
import { validatePassword } from '../../shared/validation.js'

export async function requestPasswordReset(data, env, identifier) {
    const user = await findUserByIdentifier(data, env, identifier)
    if (!user) return

    const repository = createUserRepository(data)
    const token = randomToken(32)
    await repository.createPasswordReset(sha256(token), {
        userId: user.id,
        expiresAt: Date.now() + 30 * 60 * 1000,
        createdAt: Date.now(),
    })
    const result = await sendPasswordResetEmail(env, {
        email: decryptEmail(getAppSecret(env), user.emailCipher),
        username: user.name,
        token,
    })
    const logEntry = {
        event: 'password_reset_email',
        success: result.ok,
        userId: user.id,
        provider: 'resend',
    }
    if (result.emailId) logEntry.emailId = result.emailId
    if (result.status !== undefined) logEntry.status = result.status
    if (result.error) logEntry.error = String(result.error).slice(0, 500)
    console[result.ok ? 'log' : 'error'](JSON.stringify(logEntry))
}

export async function completePasswordReset(data, token, password) {
    const passwordError = validatePassword(password)
    if (!token || passwordError) throw httpError(400, passwordError || '重置链接无效')

    const repository = createUserRepository(data)
    const tokenHash = sha256(token)
    const reset = await repository.getPasswordReset(tokenHash)
    if (!reset || reset.expiresAt <= Date.now()) {
        throw httpError(400, '重置链接无效或已使用')
    }
    const user = await findUserById(data, reset.userId)
    if (!user) throw httpError(400, '重置链接无效或已使用')

    try {
        await repository.claimPasswordReset(tokenHash, { claimedAt: Date.now() })
    } catch (error) {
        if (isPreconditionFailure(error)) throw httpError(400, '重置链接无效或已使用')
        throw error
    }

    user.passwordHash = await hashPassword(password)
    user.sessionVersion = Number(user.sessionVersion || 0) + 1
    user.updatedAt = Date.now()
    await repository.setUser(user)
    await repository.deletePasswordReset(tokenHash)
}
