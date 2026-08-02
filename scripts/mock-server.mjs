import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApiRequest } from '../server/app.js'
import { resetMemoryRateLimitsForTests } from '../server/rate-limit.js'
import { MemoryStore } from '../server/storage.js'

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url))
const PORT = Number(process.env.PORT || 4173)
const SITE_ORIGIN = 'http://127.0.0.1:4173'
const edgeoneConfig = JSON.parse(
    await readFile(new URL('../edgeone.json', import.meta.url), 'utf8'),
)
const globalResponseHeaders = Object.fromEntries(
    edgeoneConfig.headers
        .find(rule => rule.source === '/*')
        .headers.map(header => [header.key, header.value]),
)

const env = {
    ELYTRUE_APP_SECRET: process.env.ELYTRUE_APP_SECRET
        || 'e2e-mock-secret-0123456789abcdef0123456789abcdef',
    RESEND_API_KEY: process.env.RESEND_API_KEY || '',
    PUBLIC_SITE_URL: process.env.PUBLIC_SITE_URL || SITE_ORIGIN,
    ADMIN_BOOTSTRAP_SECRET: process.env.ADMIN_BOOTSTRAP_SECRET || 'e2e-bootstrap-secret',
    ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS || SITE_ORIGIN,
}

const stores = {
    data: new MemoryStore(),
    uploads: new MemoryStore(),
}

const MIME = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.webp': 'image/webp',
    '.svg': 'image/svg+xml',
    '.webm': 'video/webm',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.wav': 'audio/wav',
    '.mp4': 'video/mp4',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain; charset=utf-8',
    '.manifest': 'application/manifest+json',
}

async function resolveStaticFile(pathname) {
    const path = normalize(pathname).replace(/^[/\\]+/u, '')
    const filePath = join(ROOT, path)
    if (!filePath.startsWith(ROOT)) return null
    try {
        const info = await stat(filePath)
        if (info.isFile()) return filePath
    } catch (error) {
        return null
    }
    return null
}

function writeBody(res, buffer) {
    if (!buffer) {
        res.end()
        return
    }
    const buf = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
    res.setHeader('Content-Length', buf.length)
    res.end(buf)
}

async function handleApi(req, res) {
    const rawUrl = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    const body = await new Promise((resolve) => {
        const chunks = []
        req.on('data', chunk => chunks.push(chunk))
        req.on('end', () => resolve(Buffer.concat(chunks)))
        req.on('error', () => resolve(Buffer.alloc(0)))
    })
    const request = new Request(rawUrl.toString(), {
        method: req.method,
        headers: req.headers,
        body: ['GET', 'HEAD'].includes(req.method) ? undefined : body,
    })
    const clientIp = String(req.headers['x-forwarded-for'] || '')
        .split(',')[0]?.trim() || req.socket.remoteAddress || 'unknown'

    try {
        const response = await handleApiRequest({ request, env, clientIp }, stores)
        res.statusCode = response.status
        for (const [key, value] of response.headers) {
            if (key.toLowerCase() === 'set-cookie') continue
            res.setHeader(key, value)
        }
        const cookies = response.headers.getSetCookie
            ? response.headers.getSetCookie()
            : (response.headers.get('set-cookie') ? [response.headers.get('set-cookie')] : [])
        for (const cookie of cookies) {
            res.appendHeader('Set-Cookie', cookie)
        }
        if (req.method === 'HEAD') {
            res.end()
            return
        }
        const buffer = Buffer.from(await response.arrayBuffer())
        if (!res.headersSent && response.status !== 204 && buffer.length > 0) {
            res.setHeader('Content-Length', buffer.length)
        }
        res.end(buffer)
    } catch (error) {
        console.error('Mock API error:', error)
        res.statusCode = 500
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(JSON.stringify({ code: 500, message: 'Mock 服务器内部错误', data: null }))
    }
}

const server = createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || '127.0.0.1'}`)
    for (const [key, value] of Object.entries(globalResponseHeaders)) {
        res.setHeader(key, value)
    }

    if (url.pathname === '/__test/reset' && req.method === 'POST') {
        stores.data.values.clear()
        stores.uploads.values.clear()
        resetMemoryRateLimitsForTests()
        res.statusCode = 204
        res.end()
        return
    }

    if (url.pathname.startsWith('/api/')) {
        await handleApi(req, res)
        return
    }

    try {
        let filePath = await resolveStaticFile(url.pathname)
        if (!filePath && url.pathname !== '/') {
            const dirPath = join(ROOT, normalize(url.pathname).replace(/^[/\\]+/u, ''))
            const dirInfo = await stat(dirPath).catch(() => null)
            if (dirInfo?.isDirectory()) {
                filePath = await resolveStaticFile(url.pathname + '/index.html')
            }
        }
        if (!filePath) {
            filePath = join(ROOT, 'index.html')
        }
        const content = await readFile(filePath)
        const contentType = MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
        res.statusCode = 200
        res.setHeader('Content-Type', contentType)
        writeBody(res, content)
    } catch (error) {
        console.error('Mock static error:', error)
        res.statusCode = 500
        res.setHeader('Content-Type', 'text/plain; charset=utf-8')
        res.end('Mock 服务器错误')
    }
})

server.listen(PORT, '127.0.0.1', () => {
    console.log(`[mock-server] elytrue 本地测试服务器已启动: http://127.0.0.1:${PORT}`)
    console.log(`[mock-server] 静态目录: ${ROOT}(SPA fallback 到 index.html)`)
    console.log(`[mock-server] /api/* 由 server/app.js handleApiRequest 处理(内存 MemoryStore)`)
})
