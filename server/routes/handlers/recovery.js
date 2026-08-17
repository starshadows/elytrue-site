import { sha256 } from '../../crypto.js'
import { apiResponse, readJSON } from '../../http.js'
import { enforceRateLimit } from '../../rate-limit.js'
import { clientIdentity, environmentFor } from '../../middleware/request-context.js'
import { loadAccountRecoveryService } from '../lazy-services.js'

export async function recoverUser(context, stores) {
    const body = await readJSON(context.request, 32 * 1024)
    const identifier = String(body.identifier || '').normalize('NFKC').trim().toLowerCase()
    await enforceRateLimit('recoverIp', clientIdentity(context))
    if (identifier) await enforceRateLimit('recoverAccount', `account:${sha256(identifier)}`)
    const { recoverAccount } = await loadAccountRecoveryService()
    const result = await recoverAccount(stores.data, environmentFor(context), {
        identifier,
        recoveryKey: body.recoveryKey,
        password: body.password,
    })
    return apiResponse(result, { message: '账号已恢复，请使用新密码重新登录' })
}

export async function updateRecoveryKey(context, stores, path, auth) {
    await enforceRateLimit('recoveryKey', `user:${sha256(auth.user.id)}`)
    const body = await readJSON(context.request, 32 * 1024)
    const { rotateRecoveryKey } = await loadAccountRecoveryService()
    const result = await rotateRecoveryKey(stores.data, auth.user, body.currentPassword)
    return apiResponse(result, { message: '恢复密钥已更新，旧密钥已失效' })
}
