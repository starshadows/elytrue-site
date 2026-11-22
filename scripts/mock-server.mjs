import { createServer } from 'node:http'
import { readFile, stat } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { handleApiRequest } from '../server/app.js'
import { DOCUMENT_SECURITY_HEADERS } from '../shared/security-headers.js'

const ROOT = fileURLToPath(new URL('../dist/', import.meta.url))
const PORT = Number(process.env.PORT || 4173)
const edgeoneConfig = JSON.parse(
  await readFile(new URL('../edgeone.json', import.meta.url), 'utf8'),
)
const globalResponseHeaders = Object.fromEntries(
  edgeoneConfig.headers
    .find((rule) => rule.source === '/*')
    .headers.map((header) => [header.key, header.value]),
)

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
  '.m4s': 'video/mp4',
  '.m3u8': 'application/vnd.apple.mpegurl; charset=utf-8',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.manifest': 'application/manifest+json',
}

async function resolveStaticFile(pathname) {
  let decodedPath
  try {
    decodedPath = decodeURIComponent(pathname)
  } catch {
    return null
  }
  const path = normalize(decodedPath).replace(/^[/\\]+/u, '')
  const filePath = join(ROOT, path)
  if (!filePath.startsWith(ROOT)) return null
  try {
    const info = await stat(filePath)
    if (info.isFile()) return filePath
  } catch {
    return null
  }
  return null
}

function writeBody(response, buffer) {
  if (!buffer) {
    response.end()
    return
  }
  const body = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer)
  response.setHeader('Content-Length', body.length)
  response.end(body)
}

async function handleApi(request, response) {
  const rawUrl = new URL(
    request.url,
    `http://${request.headers.host || '127.0.0.1'}`,
  )
  const body = await new Promise((resolve) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', () => resolve(Buffer.alloc(0)))
  })
  const webRequest = new Request(rawUrl.toString(), {
    method: request.method,
    headers: request.headers,
    body: ['GET', 'HEAD'].includes(request.method) ? undefined : body,
  })

  try {
    const result = await handleApiRequest({ request: webRequest })
    response.statusCode = result.status
    for (const [key, value] of result.headers) response.setHeader(key, value)
    if (request.method === 'HEAD') {
      response.end()
      return
    }
    response.end(Buffer.from(await result.arrayBuffer()))
  } catch (error) {
    console.error('Mock API error:', error)
    response.statusCode = 500
    response.setHeader('Content-Type', 'application/json; charset=utf-8')
    response.end(
      JSON.stringify({ code: 500, message: 'Mock 服务器内部错误', data: null }),
    )
  }
}

const server = createServer(async (request, response) => {
  const url = new URL(
    request.url,
    `http://${request.headers.host || '127.0.0.1'}`,
  )
  for (const [key, value] of Object.entries(globalResponseHeaders)) {
    response.setHeader(key, value)
  }

  if (url.pathname === '/__test/reset' && request.method === 'POST') {
    response.statusCode = 204
    response.end()
    return
  }

  if (url.pathname.startsWith('/api/')) {
    await handleApi(request, response)
    return
  }

  try {
    let filePath = await resolveStaticFile(url.pathname)
    if (!filePath && url.pathname !== '/') {
      const directoryPath = join(
        ROOT,
        normalize(url.pathname).replace(/^[/\\]+/u, ''),
      )
      const directoryInfo = await stat(directoryPath).catch(() => null)
      if (directoryInfo?.isDirectory()) {
        filePath = await resolveStaticFile(url.pathname + '/index.html')
      }
    }
    if (!filePath) filePath = join(ROOT, 'index.html')

    let content = await readFile(filePath)
    const contentType =
      MIME[extname(filePath).toLowerCase()] || 'application/octet-stream'
    const range = request.headers.range?.match(/^bytes=(\d+)-(\d*)$/u)
    if (range) {
      const start = Number(range[1])
      const requestedEnd = range[2] ? Number(range[2]) : content.length - 1
      const end = Math.min(requestedEnd, content.length - 1)
      if (start >= content.length || end < start) {
        response.statusCode = 416
        response.setHeader('Content-Range', `bytes */${content.length}`)
        response.end()
        return
      }
      response.statusCode = 206
      response.setHeader('Accept-Ranges', 'bytes')
      response.setHeader(
        'Content-Range',
        `bytes ${start}-${end}/${content.length}`,
      )
      content = content.subarray(start, end + 1)
    } else {
      response.statusCode = 200
    }
    response.setHeader('Content-Type', contentType)
    if (contentType.startsWith('text/html')) {
      for (const [key, value] of Object.entries(DOCUMENT_SECURITY_HEADERS)) {
        response.setHeader(key, value)
      }
    }
    writeBody(response, content)
  } catch (error) {
    console.error('Mock static error:', error)
    response.statusCode = 500
    response.setHeader('Content-Type', 'text/plain; charset=utf-8')
    response.end('Mock 服务器错误')
  }
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(
    `[mock-server] elytrue 本地展示站已启动: http://127.0.0.1:${PORT}`,
  )
  console.log(`[mock-server] 静态目录: ${ROOT}(SPA fallback 到 index.html)`)
})
