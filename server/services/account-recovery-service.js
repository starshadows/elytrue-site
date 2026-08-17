import {
    generateRecoveryKey,
    hashPassword,
    hashRecoveryKey,
    verifyPassword,
    verifyRecoveryKey,
} from '../crypto.js'
import { findUserByIdentifier, mutateUserRecord } from '../auth.js'
import { httpError } from '../http.js'
import { validatePassword } from '../../shared/validation.js'

const INVALID_RECOVERY_MESSAGE = '账号信息或恢复密钥不正确'
const dummyRecoveryHash = hashRecoveryKey(
    'ELY-2222-2222-2222-2222-2222-2222-2222',
)

async function prepareReplacement(password) {
    const recoveryKey = generateRecoveryKey()
    const [passwordHash, recoveryKeyHash] = await Promise.all([
        password === undefined ? null : hashPassword(password),
        hashRecoveryKey(recoveryKey),
    ])
    return { passwordHash, recoveryKey, recoveryKeyHash }
}

export async function recoverAccount(data, env, { identifier, recoveryKey, password }) {
    const passwordError = validatePassword(password)
    if (passwordError) throw httpError(400, passwordError)

    const user = await findUserByIdentifier(data, env, identifier)
    const storedHash = user?.recoveryKeyHash || await dummyRecoveryHash
    const validKey = await verifyRecoveryKey(recoveryKey, storedHash)
    if (!user || !user.recoveryKeyHash || !validKey) {
        throw httpError(400, INVALID_RECOVERY_MESSAGE)
    }

    const replacement = await prepareReplacement(password)
    const mutation = await mutateUserRecord(
        data,
        user,
        current => {
            if (current.recoveryKeyHash !== user.recoveryKeyHash) {
                throw httpError(400, INVALID_RECOVERY_MESSAGE)
            }
            current.passwordHash = replacement.passwordHash
            current.recoveryKeyHash = replacement.recoveryKeyHash
            current.recoveryKeyCreatedAt = Date.now()
            current.sessionVersion = Number(current.sessionVersion || 0) + 1
            return { recoveryKey: replacement.recoveryKey }
        },
        {
            claimType: 'account-recovery',
            conflictStatus: 400,
            conflictMessage: INVALID_RECOVERY_MESSAGE,
        },
    )
    return mutation.result
}

export async function rotateRecoveryKey(data, authenticatedUser, currentPassword) {
    if (!await verifyPassword(currentPassword, authenticatedUser.passwordHash)) {
        throw httpError(401, '当前密码不正确')
    }

    const replacement = await prepareReplacement(undefined)
    const mutation = await mutateUserRecord(
        data,
        authenticatedUser,
        async current => {
            if (!await verifyPassword(currentPassword, current.passwordHash)) {
                throw httpError(401, '当前密码不正确')
            }
            current.recoveryKeyHash = replacement.recoveryKeyHash
            current.recoveryKeyCreatedAt = Date.now()
            return { recoveryKey: replacement.recoveryKey }
        },
        {
            claimType: 'recovery-key-rotation',
            conflictMessage: '恢复密钥正在更新，请稍后重试',
        },
    )
    return mutation.result
}
