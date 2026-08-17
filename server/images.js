import { httpError } from './http.js'

const PNG_SIGNATURE = Buffer.from('89504e470d0a1a0a', 'hex')

const TYPES = [
    {
        type: 'image/jpeg',
        ext: 'jpg',
        match: (bytes) => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff,
    },
    {
        type: 'image/png',
        ext: 'png',
        match: (bytes) => bytes.subarray(0, 8).equals(PNG_SIGNATURE),
    },
    {
        type: 'image/webp',
        ext: 'webp',
        match: (bytes) => bytes.subarray(0, 4).toString('ascii') === 'RIFF'
            && bytes.subarray(8, 12).toString('ascii') === 'WEBP',
    },
]

const JPEG_START_OF_FRAME_MARKERS = new Set([
    0xc0, 0xc1, 0xc2, 0xc3,
    0xc5, 0xc6, 0xc7,
    0xc9, 0xca, 0xcb,
    0xcd, 0xce, 0xcf,
])

function pngDimensions(buffer) {
    if (
        buffer.length < 24
        || buffer.readUInt32BE(8) !== 13
        || buffer.subarray(12, 16).toString('ascii') !== 'IHDR'
    ) {
        throw new Error('invalid PNG header')
    }
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) }
}

function jpegDimensions(buffer) {
    let offset = 2
    while (offset < buffer.length) {
        if (buffer[offset] !== 0xff) throw new Error('invalid JPEG marker')
        while (buffer[offset] === 0xff) offset += 1
        if (offset >= buffer.length) break

        const marker = buffer[offset]
        offset += 1
        if (marker === 0xd9 || marker === 0xda) break
        if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue
        if (offset + 2 > buffer.length) break

        const segmentLength = buffer.readUInt16BE(offset)
        if (segmentLength < 2 || offset + segmentLength > buffer.length) {
            throw new Error('invalid JPEG segment')
        }
        if (JPEG_START_OF_FRAME_MARKERS.has(marker)) {
            if (segmentLength < 7) throw new Error('invalid JPEG frame')
            return {
                width: buffer.readUInt16BE(offset + 5),
                height: buffer.readUInt16BE(offset + 3),
            }
        }
        offset += segmentLength
    }
    throw new Error('JPEG dimensions not found')
}

function webpChunkDimensions(type, buffer, offset, size) {
    if (type === 'VP8X' && size >= 10) {
        return {
            width: buffer.readUIntLE(offset + 4, 3) + 1,
            height: buffer.readUIntLE(offset + 7, 3) + 1,
        }
    }
    if (type === 'VP8L' && size >= 5 && buffer[offset] === 0x2f) {
        const bits = buffer.readUInt32LE(offset + 1)
        return {
            width: (bits & 0x3fff) + 1,
            height: ((bits >>> 14) & 0x3fff) + 1,
        }
    }
    if (
        type === 'VP8 '
        && size >= 10
        && buffer[offset + 3] === 0x9d
        && buffer[offset + 4] === 0x01
        && buffer[offset + 5] === 0x2a
    ) {
        return {
            width: buffer.readUInt16LE(offset + 6) & 0x3fff,
            height: buffer.readUInt16LE(offset + 8) & 0x3fff,
        }
    }
    return null
}

function webpDimensions(buffer) {
    const containerEnd = buffer.readUInt32LE(4) + 8
    if (containerEnd < 12 || containerEnd > buffer.length) {
        throw new Error('invalid WebP container')
    }

    let offset = 12
    while (offset + 8 <= containerEnd) {
        const type = buffer.subarray(offset, offset + 4).toString('ascii')
        const size = buffer.readUInt32LE(offset + 4)
        const dataOffset = offset + 8
        if (size > containerEnd - dataOffset) throw new Error('invalid WebP chunk')

        const dimensions = webpChunkDimensions(type, buffer, dataOffset, size)
        if (dimensions) return dimensions

        offset = dataOffset + size + (size % 2)
    }
    throw new Error('WebP dimensions not found')
}

function imageDimensions(buffer, ext) {
    if (ext === 'png') return pngDimensions(buffer)
    if (ext === 'jpg') return jpegDimensions(buffer)
    return webpDimensions(buffer)
}

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
        dimensions = imageDimensions(buffer, detected.ext)
    } catch {
        throw httpError(415, '无法识别图片内容')
    }
    const width = Number(dimensions.width || 0)
    const height = Number(dimensions.height || 0)
    if (!width || !height || width > 10000 || height > 10000 || width * height > 24_000_000) {
        throw httpError(413, '图片尺寸超出限制')
    }
    return { type: detected.type, ext: detected.ext, width, height }
}

export function contentTypeForKey(key) {
    if (key.endsWith('.png')) return 'image/png'
    if (key.endsWith('.webp')) return 'image/webp'
    return 'image/jpeg'
}
