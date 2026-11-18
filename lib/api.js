/**
 * 页面对话用的本机 HTTP 接口。
 *
 * 用 Node 的 handler（req/res），不用 Web Resource：Web Resource 只接受 GET/HEAD，
 * 页面要 POST JSON，所以这里自己读写流。
 *
 * 认人：页面启动时注入的 token；没有 token 时只放行「回环地址 + 同源」的本机请求。
 */
import { timingSafeEqual } from 'node:crypto'

const MAX_BODY = 4 * 1024 * 1024

function send(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
  })
  res.end(body)
}

function sameToken(actual, expected) {
  if (typeof actual !== 'string' || actual.length !== expected.length) return false
  try {
    return timingSafeEqual(Buffer.from(actual), Buffer.from(expected))
  } catch {
    return false
  }
}

function hostnameOf(req) {
  const raw = String(req.headers.host ?? '')
  if (!raw) return ''
  try {
    return new URL('http://' + raw).hostname.toLowerCase()
  } catch {
    return ''
  }
}

function isLoopback(hostname) {
  return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '[::1]' || hostname === '::1'
}

function sameOrigin(req) {
  const origin = req.headers.origin
  if (!origin || origin === 'null') return true
  try {
    return new URL(origin).host === String(req.headers.host ?? '')
  } catch {
    return false
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('请求体太大'), { code: 'TOO_LARGE' }))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
    req.on('error', reject)
  })
}

export function createApi({ service, token, basePath, logger = () => {} }) {
  let warned = false

  return async function cattiHandler(req, res) {
    try {
      const url = new URL(req.url ?? '/', 'http://localhost')
      if (!url.pathname.startsWith(basePath)) {
        return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: 'not found' } })
      }

      let allowed = sameToken(req.headers['x-catti-token'], token)
      if (!allowed) {
        const hostname = hostnameOf(req)
        if (isLoopback(hostname) && sameOrigin(req)) {
          allowed = true
          if (!warned) {
            warned = true
            logger(`[catti] 有一个请求没带 token，按回环同源放行（Host=${hostname}）。`)
          }
        }
      }
      if (!allowed) return send(res, 401, { ok: false, error: { code: 'UNAUTHORIZED', message: 'token 无效' } })

      const method = String(req.method ?? 'GET').toUpperCase()
      if (method === 'OPTIONS') {
        res.writeHead(204, { allow: 'GET, POST, OPTIONS' })
        return res.end()
      }

      const actionPath = url.pathname.slice(basePath.length).replace(/^\/+|\/+$/gu, '')
      if (method === 'GET') {
        if (actionPath === 'ping') return send(res, 200, { ok: true, data: { ready: true } })
        if (actionPath === 'state') {
          try {
            return send(res, 200, { ok: true, data: await service.handle('state', {}) })
          } catch (error) {
            return send(res, 400, { ok: false, error: { code: error?.code ?? 'ERROR', message: String(error?.message ?? error) } })
          }
        }
        return send(res, 404, { ok: false, error: { code: 'NOT_FOUND', message: `unknown path ${url.pathname}` } })
      }
      if (method !== 'POST') {
        res.writeHead(405, { allow: 'GET, POST, OPTIONS' })
        return res.end()
      }

      let body = {}
      try {
        const text = await readBody(req)
        body = text ? JSON.parse(text) : {}
      } catch (error) {
        const code = error?.code ?? 'BAD_JSON'
        return send(res, code === 'TOO_LARGE' ? 413 : 400, {
          ok: false,
          error: { code, message: code === 'TOO_LARGE' ? '请求体太大' : '请求体不是合法 JSON' },
        })
      }

      try {
        const data = await service.handle(body.action ?? actionPath, body.payload ?? {})
        return send(res, 200, { ok: true, data })
      } catch (error) {
        const code = error?.code ?? 'ERROR'
        const message = String(error?.message ?? error)
        logger(`[catti] ${body.action ?? actionPath} 失败：${message}`)
        return send(res, code === 'NOT_FOUND' ? 404 : 400, { ok: false, error: { code, message } })
      }
    } catch (error) {
      try {
        if (!res.headersSent) send(res, 500, { ok: false, error: { code: 'INTERNAL', message: String(error?.message ?? error) } })
        else res.end()
      } catch {
        /* 连接已经断了 */
      }
    }
  }
}
