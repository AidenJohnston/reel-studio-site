// Plays the app against a posting server: health, sign in with a purchase key, /v1/me, and optionally the start
// of Connect YouTube (checks Google accepts our authorize URL) and a whole upload. Signs out at the end. Prints
// outcomes, never the key, the session or a Google token.
//
//   node tools/smoke.mjs --base https://post-staging.getreelstudio.com --key-file <purchase key>
//        [--connect-check | --connect] [--upload <video.mp4> --title "…" [--privacy private|unlisted|public]] [--keep-session]
//
// --connect-check stops at Google's sign-in page (proves Google accepts the client and the redirect URI).
// --connect finishes the flow against the fake Google run with --auto (a local run; tools/fake-google-server.mjs).
// Every --upload is a real YouTube upload when the server talks to real Google: it uses one of the project's
// 100 uploads a day.
import { open, readFile, stat } from 'node:fs/promises'

const args = process.argv.slice(2)
const has = (name) => args.includes(name)
const opt = (name, fallback) => {
  const i = args.indexOf(name)
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback
}
const base = (opt('--base') ?? '').replace(/\/+$/, '')
if (!/^https?:\/\//.test(base)) throw new Error('--base https://… is required')
const key = (await readFile(opt('--key-file') ?? '', 'utf8')).replace(/\s+/g, '')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let session = null
async function api(method, path, { body, headers = {}, auth = 'session' } = {}) {
  const h = { 'X-Reel-Studio-Version': 'smoke', ...headers }
  if (auth === 'key') h.Authorization = `Bearer ${key}`
  else if (auth === 'session' && session) h.Authorization = `Bearer ${session}`
  let payload = body
  if (body && !(body instanceof Uint8Array)) {
    payload = JSON.stringify(body)
    h['Content-Type'] = 'application/json'
  }
  const res = await fetch(base + path, { method, headers: h, body: payload, redirect: 'manual' })
  const text = await res.text()
  let json = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {}
  return { status: res.status, json, text, headers: res.headers }
}

function step(name, ok, detail = '') {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${detail ? `: ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
  return ok
}

const health = await api('GET', '/v1/health', { auth: 'none' })
step('health', health.status === 200 && health.json?.ok === true, JSON.stringify(health.json))

const device = process.platform === 'darwin' ? 'Mac' : process.platform === 'win32' ? 'Windows' : 'Linux'
const signIn = await api('POST', '/v1/sessions', { auth: 'key', body: { device } })
if (!step('sign in (POST /v1/sessions)', signIn.status === 201, signIn.status === 201 ? `plan ${signIn.json.plan}, ${signIn.json.sessionId.slice(0, 10)}…` : `${signIn.status} ${signIn.text}`)) process.exit(1)
session = signIn.json.session

try {
  const me = await api('GET', '/v1/me')
  const yt = me.json?.connections?.find((c) => c.platform === 'youtube')
  step('GET /v1/me', me.status === 200, me.status === 200 ? `other computers ${me.json.otherSessions}, YouTube ${yt ? `${yt.status}${yt.channelId ? ` (channel ${yt.channelId.slice(0, 6)}…)` : ''}` : 'not connected'}` : me.text)

  if (has('--connect-check') || has('--connect')) {
    const a = await api('POST', '/v1/connections/youtube/attempts')
    if (step('start connect (POST attempts)', a.status === 201, a.status === 201 ? `poll every ${a.json.pollMs} ms` : `${a.status} ${a.text}`)) {
      const openUrl = new URL(a.json.openUrl)
      step('openUrl is on the posting server', openUrl.origin === new URL(base).origin, openUrl.origin + openUrl.pathname)
      const begin = await fetch(openUrl, { redirect: 'manual' })
      const toGoogle = begin.headers.get('location') ?? ''
      step('begin → Google', begin.status === 302 && (has('--connect') || toGoogle.startsWith('https://accounts.google.com/')), `${begin.status} ${toGoogle ? new URL(toGoogle).host + new URL(toGoogle).pathname : ''}`)
      if (toGoogle && has('--connect')) {
        // The fake Google (auto-approve) sends the browser straight back to the callback; carry the cookie.
        const cookie = (begin.headers.get('set-cookie') ?? '').split(';')[0]
        const g = await fetch(toGoogle, { redirect: 'manual' })
        const back = g.headers.get('location') ?? ''
        const cb = back ? await fetch(back, { redirect: 'manual', headers: { Cookie: cookie } }) : null
        step('callback page', cb?.status === 200, `${cb?.status ?? g.status} ${cb ? /<h1>([^<]*)<\/h1>/.exec(await cb.text())?.[1] ?? '' : ''}`)
        const polled = await api('GET', `/v1/connections/youtube/attempts/${a.json.attemptId}`)
        step('attempt outcome', polled.json?.status === 'connected', JSON.stringify({ status: polled.json?.status, channelName: polled.json?.connection?.channelName ?? null }))
      } else if (toGoogle) {
        const q = new URL(toGoogle).searchParams
        console.log(`     redirect_uri ${q.get('redirect_uri')}, scope ${q.get('scope')}, pkce ${q.get('code_challenge_method') ?? 'off'}`)
        // Google answers a bad client or redirect URI with an error page (or a redirect to one); a good one with
        // its sign-in or consent screen.
        const g = await fetch(toGoogle, { redirect: 'manual' })
        const where = g.headers.get('location') ?? ''
        const text = g.status === 200 || g.status >= 400 ? await g.text() : ''
        const bad = /invalid_client|redirect_uri_mismatch|invalid_request|authError|Error 400|Error 401/.test(where + text)
        step('Google accepts the authorize URL', !bad && (g.status === 200 || g.status === 302), `${g.status} ${where ? new URL(where, 'https://accounts.google.com').pathname : ''}`)
      }
      if (!has('--connect')) {
        const cancel = await api('DELETE', `/v1/connections/youtube/attempts/${a.json.attemptId}`)
        step('cancel the attempt', cancel.status === 200)
      }
    }
  }

  const file = opt('--upload')
  if (file) {
    const size = (await stat(file)).size
    const start = await api('POST', '/v1/uploads', {
      body: { platform: 'youtube', size, mimeType: 'video/mp4', title: opt('--title', 'Reel Studio staging test'), description: 'A test upload from the Reel Studio posting server. Safe to delete.', privacy: opt('--privacy', 'private'), madeForKids: false }
    })
    if (step('open upload (POST /v1/uploads)', start.status === 201, start.status === 201 ? `${size} bytes, chunk ${start.json.chunkSize}` : `${start.status} ${start.text}`)) {
      const { uploadId, chunkSize } = start.json
      const fh = await open(file, 'r')
      let received = 0
      let result = null
      let tries = 0
      try {
        while (!result) {
          const len = Math.min(chunkSize, size - received)
          const buf = new Uint8Array(len)
          await fh.read(buf, 0, len, received)
          const r = await api('PUT', `/v1/uploads/${uploadId}`, { body: buf, headers: { 'Content-Type': 'application/octet-stream', 'Content-Range': `bytes ${received}-${received + len - 1}/${size}` } })
          if (r.status === 200 && r.json.status === 'done') result = r.json
          else if (r.status === 200) received = r.json.received
          else if (r.status === 409 && r.json?.error === 'offset_mismatch') received = r.json.received
          else if (r.status === 502 && r.json?.retry && tries++ < 5) {
            await sleep(2000 * tries)
            const s = await api('GET', `/v1/uploads/${uploadId}`)
            if (s.json?.status === 'done') result = s.json
            else if (s.status === 200) received = s.json.received
          } else {
            step('send chunk', false, `${r.status} ${r.text}`)
            break
          }
          if (!result) console.log(`     sent ${received} of ${size}`)
        }
      } finally {
        await fh.close()
      }
      if (result) step('upload done', !!result.video, `video ${result.video?.id}, privacy ${result.video?.privacy}, ${result.video?.studioUrl}`)
    }
  }
} finally {
  if (!has('--keep-session')) {
    const out = await api('DELETE', '/v1/sessions/current')
    step('sign out (DELETE /v1/sessions/current)', out.status === 200)
  }
}
