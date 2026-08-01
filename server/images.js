import { imageSize } from 'image-size'
import { httpError } from './http.js'

const TYPES = [
    { type: 'image/jpeg', ext: 'jpg', match: bytes => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff },
    { type: 'image/png', ext: 'png', match: bytes => bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 },
    { type: 'image/webp', ext: 'webp', match: bytes => Buffer.from(bytes.subarray(0, 4)).toString('ascii') === 'RIFF' && Buffer.from(bytes.subarray(8, 12)).toString('ascii') === 'WEBP' },
]

export function decodeBase64Image(value, maxBytes) {
    if (typeof value !== 'string' || !value) throw httpError(400, '图片数据无效')
    const normalized = value.replace(/^data:[^;]+;base64,/u, '')
    if (!/^[a-z0-9+/=\s]+$/iu.test(normalized)) throw httpError(400, '图片数据无效')
    const buffer = Buffer.from(normalized, 'base64')
    if (!buffer.length || buffer.length > maxBytes) throw httpError(413, `图片不能超过 ${Math.floor(maxBytes / 1024 / 1024) || 1} MiB`)
    return buffer
}

export function validateImage(buffer, maxBytes) {
    if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer)
    if (!buffer.length || buffer.length > maxBytes) throw httpError(413, '图片体积超出限制')
    const detected = TYPES.find(candidate => candidate.match(buffer))
    if (!detected) throw httpError(415, '仅支持静态 JPEG、PNG 或 WebP 图片')
    let dimensions
    try {
        dimensions = imageSize(buffer)
    } catch {
        throw httpError(415, '无法识别图片内容')
    }
    const width = Number(dimensions.width || 0)
    const height = Number(dimensions.height || 0)
    if (!width || !height || width > 10000 || height > 10000 || width * height > 24_000_000) {
        throw httpError(413, '图片尺寸超出限制')
    }
    return { ...detected, width, height }
}

export function contentTypeForKey(key) {
    if (key.endsWith('.png')) return 'image/png'
    if (key.endsWith('.webp')) return 'image/webp'
    return 'image/jpeg'
}
