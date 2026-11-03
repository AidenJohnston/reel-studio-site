// The fake Google (test/fake-google.ts) over HTTP, for running the posting Worker and the app locally with no
// Google account and no quota. Node 24 runs the TypeScript file as it is.
//
//   node tools/fake-google-server.mjs [--port 8790] [--auto] [--no-channel] [--no-readonly]
//
// --auto skips the Allow/Cancel page. Point the Worker at it with the vars it prints (posting/.dev.vars).
// Extras, for checking and for injecting failures by hand:
//   GET  /__fake/state            uploads (id, size, received, done, title, privacy) and token counts, never tokens
//   POST /__fake/faults           a fault or an array of them, e.g. {"on":"chunk","dropAfterBytes":300000}
//   POST /__fake/flags            {"quotaExceeded":true} {"uploadLimitExceeded":true} {"channel":null} {"autoApprove":true}
//   POST /__fake/revoke-all       every refresh token now answers invalid_grant
//   POST /__fake/expire?id=u1     that upload session now answers 404
import http from 'node:http'
import { createFakeGoogle } from '../test/fake-google.ts'

const args = process.argv.slice(2)
const flag = (name) => args.includes(name)
const value = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const port = Number(value('--port', '8790'))
const origin = `http://127.0.0.1:${port}`
const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload'
const SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly'

const google = createFakeGoogle({
  origin,
  autoApprove: flag('--auto'),
  ...(flag('--no-channel') ? { channel: null } : {}),
  ...(flag('--no-readonly') ? { grantedScopes: [SCOPE_UPLOAD] } : { grantedScopes: [SCOPE_UPLOAD, SCOPE_READONLY] })
})

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body, null, 2))
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', origin)
  try {
    const raw = await readBody(req)
    if (url.pathname === '/__fake/state' && req.method === 'GET') return sendJson(res, 200, google.summary())
    if (url.pathname === '/__fake/faults' && req.method === 'POST') {
      const f = JSON.parse(raw.toString('utf8') || '[]')
      google.state.faults.push(...(Array.isArray(f) ? f : [f]))
      return sendJson(res, 200, { ok: true, queued: google.state.faults.length })
    }
    if (url.pathname === '/__fake/flags' && req.method === 'POST') {
      const f = JSON.parse(raw.toString('utf8') || '{}')
      for (const k of ['quotaExceeded', 'uploadLimitExceeded', 'channel', 'autoApprove', 'grantedScopes']) if (k in f) google.state[k] = f[k]
      return sendJson(res, 200, { ok: true })
    }
    if (url.pathname === '/__fake/revoke-all' && req.method === 'POST') {
      google.revokeAll()
      return sendJson(res, 200, { ok: true })
    }
    if (url.pathname === '/__fake/expire' && req.method === 'POST') {
      google.expireUpload(url.searchParams.get('id') ?? '')
      return sendJson(res, 200, { ok: true })
    }

    const headers = new Headers()
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string') headers.set(k, v)
    const hasBody = req.method !== 'GET' && req.method !== 'HEAD'
    const answer = await google.handle(new Request(url, { method: req.method, headers, body: hasBody ? raw : undefined }))
    const out = Buffer.from(await answer.arrayBuffer())
    const h = {}
    answer.headers.forEach((v, k) => (h[k] = v))
    res.writeHead(answer.status, h)
    res.end(out)
  } catch (e) {
    if (e instanceof TypeError && e.message === 'network') {
      // An injected dropped connection: hang up without an answer.
      req.socket.destroy()
      return
    }
    console.error(`[fake-google] ${req.method} ${url.pathname}: ${e?.stack ?? e}`)
    if (!res.headersSent) sendJson(res, 500, { error: 'fake_google_crashed' })
  }
})

server.listen(port, '127.0.0.1', () => {
  console.log(`[fake-google] listening on ${origin}${flag('--auto') ? ' (auto-approve)' : ' (Allow/Cancel page)'}`)
  console.log('[fake-google] posting/.dev.vars:')
  for (const [k, v] of Object.entries(google.env)) console.log(`${k}=${v}`)
})
