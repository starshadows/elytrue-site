import {
    createCipheriv,
    createDecipheriv,
    createHash,
    createHmac,
    randomBytes,
    scrypt as scryptCallback,
    timingSafeEqual,
} from 'node:crypto'

function scrypt(password, salt, keyLength, options) {
    return new Promise((resolve, reject) => {
        scryptCallback(password, salt, keyLength, options, (error, derivedKey) => {
            if (error) reject(error)
            else resolve(derivedKey)
        })
    })
}

function toBase64Url(value) {
    return Buffer.from(value).toString('base64url')
}

function fromBase64Url(value) {
    return Buffer.from(value, 'base64url')
}

const RECOVERY_KEY_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const RECOVERY_KEY_CHARACTERS = 28
const RECOVERY_KEY_GROUP_SIZE = 4
const SCRYPT_OPTIONS = Object.freeze({
    N: 16384,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
})

function formatRecoveryKey(characters) {
    const groups = []
    for (let index = 0; index < characters.length; index += RECOVERY_KEY_GROUP_SIZE) {
        groups.push(characters.slice(index, index + RECOVERY_KEY_GROUP_SIZE))
    }
    return `ELY-${groups.join('-')}`
}

export function randomToken(bytes = 32) {
    return toBase64Url(randomBytes(bytes))
}

export function sha256(value) {
    return createHash('sha256').update(String(value)).digest('hex')
}

export function keyedDigest(secret, value, purpose) {
    return createHmac('sha256', deriveKey(secret, purpose))
        .update(String(value))
        .digest('hex')
}

function deriveKey(secret, purpose) {
    return createHash('sha256')
        .update(`elytrue:${purpose}:`)
        .update(String(secret))
        .digest()
}

export async function hashPassword(password) {
    const salt = randomBytes(16)
    const derived = await scrypt(String(password), salt, 64, SCRYPT_OPTIONS)
    return `scrypt$16384$8$1$${toBase64Url(salt)}$${toBase64Url(derived)}`
}

export async function verifyPassword(password, stored) {
    try {
        const [algorithm, n, r, p, saltEncoded, hashEncoded] = String(stored).split('$')
        if (algorithm !== 'scrypt') return false
        const expected = fromBase64Url(hashEncoded)
        const actual = await scrypt(String(password), fromBase64Url(saltEncoded), expected.length, {
            N: Number(n),
            r: Number(r),
            p: Number(p),
            maxmem: 64 * 1024 * 1024,
        })
        return expected.length === actual.length && timingSafeEqual(expected, actual)
    } catch {
        return false
    }
}

export function normalizeRecoveryKey(value) {
    const compact = String(value ?? '').normalize('NFKC').toUpperCase().replace(/[\s-]+/gu, '')
    if (!compact.startsWith('ELY')) return null
    const characters = compact.slice(3)
    if (
        characters.length !== RECOVERY_KEY_CHARACTERS
        || [...characters].some(character => !RECOVERY_KEY_ALPHABET.includes(character))
    ) {
        return null
    }
    return formatRecoveryKey(characters)
}

export function generateRecoveryKey() {
    let characters = ''
    const unbiasedLimit = Math.floor(256 / RECOVERY_KEY_ALPHABET.length) * RECOVERY_KEY_ALPHABET.length
    while (characters.length < RECOVERY_KEY_CHARACTERS) {
        for (const byte of randomBytes(RECOVERY_KEY_CHARACTERS)) {
            if (byte >= unbiasedLimit) continue
            characters += RECOVERY_KEY_ALPHABET[byte % RECOVERY_KEY_ALPHABET.length]
            if (characters.length === RECOVERY_KEY_CHARACTERS) break
        }
    }
    return formatRecoveryKey(characters)
}

export async function hashRecoveryKey(recoveryKey) {
    const normalized = normalizeRecoveryKey(recoveryKey)
    if (!normalized) throw new TypeError('Invalid recovery key')
    const salt = randomBytes(16)
    const derived = await scrypt(normalized, salt, 64, SCRYPT_OPTIONS)
    return `recovery-scrypt$1$16384$8$1$${toBase64Url(salt)}$${toBase64Url(derived)}`
}

export async function verifyRecoveryKey(recoveryKey, stored) {
    try {
        const supplied = normalizeRecoveryKey(recoveryKey)
        const normalized = supplied || 'ELY-2222-2222-2222-2222-2222-2222-2222'
        const [algorithm, version, n, r, p, saltEncoded, hashEncoded] = String(stored).split('$')
        if (algorithm !== 'recovery-scrypt' || version !== '1') return false
        const expected = fromBase64Url(hashEncoded)
        const actual = await scrypt(normalized, fromBase64Url(saltEncoded), expected.length, {
            N: Number(n),
            r: Number(r),
            p: Number(p),
            maxmem: SCRYPT_OPTIONS.maxmem,
        })
        return Boolean(supplied) && expected.length === actual.length && timingSafeEqual(expected, actual)
    } catch {
        return false
    }
}

export function encryptEmail(secret, email) {
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', deriveKey(secret, 'email-encryption'), iv)
    const encrypted = Buffer.concat([cipher.update(String(email), 'utf8'), cipher.final()])
    const tag = cipher.getAuthTag()
    return `${toBase64Url(iv)}.${toBase64Url(tag)}.${toBase64Url(encrypted)}`
}

export function decryptEmail(secret, encoded) {
    const [ivEncoded, tagEncoded, dataEncoded] = String(encoded).split('.')
    const decipher = createDecipheriv(
        'aes-256-gcm',
        deriveKey(secret, 'email-encryption'),
        fromBase64Url(ivEncoded),
    )
    decipher.setAuthTag(fromBase64Url(tagEncoded))
    return Buffer.concat([
        decipher.update(fromBase64Url(dataEncoded)),
        decipher.final(),
    ]).toString('utf8')
}
