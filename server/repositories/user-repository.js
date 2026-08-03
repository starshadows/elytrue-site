import { blobKeys } from '../domain/blob-keys.js'
import { getJSON } from '../storage.js'

export function createUserRepository(data) {
    return Object.freeze({
        createPasswordReset: (tokenHash, value) =>
            data.setJSON(blobKeys.passwordReset(tokenHash), value, { onlyIfNew: true }),
        getPasswordReset: tokenHash => getJSON(data, blobKeys.passwordReset(tokenHash)),
        claimPasswordReset: (tokenHash, value) =>
            data.setJSON(blobKeys.passwordResetClaim(tokenHash), value, { onlyIfNew: true }),
        deletePasswordReset: tokenHash => data.delete(blobKeys.passwordReset(tokenHash)),
        setUser: user => data.setJSON(blobKeys.user(user.id), user),
    })
}
