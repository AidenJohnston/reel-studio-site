// A fake Google for the posting Worker: OAuth (authorize, token, revoke), channels.list and YouTube's resumable
// upload, on the same paths as Google's so only the origin differs. Tests use `fetch` (a drop-in for
// Deps.fetch); tools/fake-google-server.mjs serves it over HTTP for a local run of the Worker and the app.
//
// Plain erasable TypeScript with no imports (no enums, no parameter properties), so Node runs it as it is.
// It never logs or reports a token's value: `calls` and summary() name requests, not credentials.

export interface FakeGoogleOptions {
  origin?: string // default 'https://fake-google.test'
  clientId?: string // default 'fake-client-id'
  clientSecret?: string // default 'fake-client-secret'
  autoApprove?: boolean // default true (tests); the runner defaults to false (an Allow/Cancel page) unless --auto
  grantedScopes?: string[] // default both scopes; drop youtube.upload or youtube.readonly to test those paths
  channel?: FakeChannel | null // null = an account with no channel
  accessTokenTtlSec?: number // default 3599
  requirePkce?: boolean // default true
}

export interface FakeChannel {
  id: string
  title: string
  customUrl?: string
}

export interface FakeUpload {
  metadata: unknown
  size: number
  mime: string
  /** What arrived so far, in order. */
  readonly bytes: Uint8Array
  received: number
  done: boolean
  videoId?: string
  expired?: boolean
}

export interface FakeFault {
  on: 'authorize' | 'token' | 'refresh' | 'revoke' | 'channels' | 'init' | 'chunk' | 'status'
  status?: number
  reason?: string
  times?: number
  /** 'chunk' only: keep this many bytes (rounded down to 256 KiB) then throw TypeError('network') */
  dropAfterBytes?: number
}

export interface FakeGoogle {
  origin: string
  /** Drop-in for Deps.fetch: routes requests for `origin` to the fake, throws for anything else. */
  fetch: typeof fetch
  handle(req: Request): Promise<Response>
  /** Env vars that point the posting Worker here. */
  env: {
    GOOGLE_AUTH_URL: string
    GOOGLE_TOKEN_URL: string
    GOOGLE_REVOKE_URL: string
    YOUTUBE_API_URL: string
    YOUTUBE_UPLOAD_URL: string
    GOOGLE_CLIENT_ID: string
    GOOGLE_CLIENT_SECRET: string
  }
  state: {
    uploads: Map<string, FakeUpload>
    refreshTokens: Map<string, { scopes: string[]; revoked: boolean }>
    accessTokens: Map<string, { refresh: string; scopes: string[]; expiresAt: number }>
    revoked: string[] // tokens passed to /revoke, in order
    calls: string[] // 'POST /token grant_type=refresh_token', 'PUT upload u1 bytes 0-262143/600000', … (never token values)
    /** Queued failures, consumed in order. */
    faults: FakeFault[]
    quotaExceeded: boolean // init → 403 quotaExceeded
    uploadLimitExceeded: boolean // init → 400 uploadLimitExceeded
    now(): number // overridable clock for token expiry
    /** Changeable during a test (the options' values to start with). */
    autoApprove: boolean
    grantedScopes: string[]
    channel: FakeChannel | null
  }
  expireUpload(id: string): void // its session URI now answers 404
  revokeAll(): void // every refresh token → invalid_grant (the 7-day Testing expiry, or removed in Google settings)
  /** For GET /__fake/state: uploads and token counts, never token values. */
  summary(): unknown
}

const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload'
const SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly'
const GRAIN = 262144
const CODE_MS = 10 * 60_000

function b64url(bytes: Uint8Array): string {
  let s = ''
  for (const b of bytes) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function rand(n = 24): string {
  return b64url(crypto.getRandomValues(new Uint8Array(n)))
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier))))
}

function jsonRes(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=UTF-8', ...headers } })
}

/** YouTube's error shape. */
function ytError(code: number, reason: string, message = reason): Response {
  return jsonRes({ error: { code, message, errors: [{ message, domain: 'youtube.api', reason }] } }, code)
}

/** The OAuth endpoints' error shape. */
function oauthError(status: number, error: string, description?: string): Response {
  return jsonRes(description ? { error, error_description: description } : { error }, status)
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string)
}

export function createFakeGoogle(opts: FakeGoogleOptions = {}): FakeGoogle {
  const origin = (opts.origin ?? 'https://fake-google.test').replace(/\/+$/, '')
  const clientId = opts.clientId ?? 'fake-client-id'
  const clientSecret = opts.clientSecret ?? 'fake-client-secret'
  const ttlSec = opts.accessTokenTtlSec ?? 3599
  const requirePkce = opts.requirePkce ?? true
  const codes = new Map<string, { redirectUri: string; challenge: string | null; method: string; scopes: string[]; expiresAt: number; used: boolean }>()
  /** Per upload: the grant (refresh token) that opened it, the chunks, and the video once done. */
  const uploadExtra = new Map<string, { refresh: string; chunks: Uint8Array[]; video?: unknown }>()
  let uploadCount = 0
  let videoCount = 0

  const state: FakeGoogle['state'] = {
    uploads: new Map(),
    refreshTokens: new Map(),
    accessTokens: new Map(),
    revoked: [],
    calls: [],
    faults: [],
    quotaExceeded: false,
    uploadLimitExceeded: false,
    now: () => Date.now(),
    autoApprove: opts.autoApprove ?? true,
    grantedScopes: opts.grantedScopes ?? [SCOPE_UPLOAD, SCOPE_READONLY],
    channel: opts.channel === undefined ? { id: 'UCfakeChannel00000000001', title: 'Fake Channel', customUrl: '@fakechannel' } : opts.channel
  }

  function takeFault(on: FakeFault['on']): FakeFault | null {
    const i = state.faults.findIndex((f) => f.on === on)
    if (i < 0) return null
    const f = state.faults[i]
    const left = (f.times ?? 1) - 1
    if (left <= 0) state.faults.splice(i, 1)
    else f.times = left
    return f
  }

  function issueAccess(refresh: string, scopes: string[]): string {
    const token = 'ya29.fake-' + rand()
    state.accessTokens.set(token, { refresh, scopes, expiresAt: state.now() + ttlSec * 1000 })
    return token
  }

  /** The live access token in `Authorization: Bearer`, or null. */
  function liveAccess(req: Request): { token: string; refresh: string; scopes: string[] } | null {
    const auth = req.headers.get('authorization') ?? ''
    if (!auth.startsWith('Bearer ')) return null
    const token = auth.slice(7)
    const a = state.accessTokens.get(token)
    if (!a || a.expiresAt <= state.now()) return null
    const r = state.refreshTokens.get(a.refresh)
    if (!r || r.revoked) return null
    return { token, refresh: a.refresh, scopes: a.scopes }
  }

  function redirect(location: string): Response {
    return new Response(null, { status: 302, headers: { Location: location } })
  }

  /** The checks Google makes on the authorize request; a string is the error. */
  function checkAuthorize(q: URLSearchParams): string | null {
    if (q.get('client_id') !== clientId) return 'invalid_client'
    if (q.get('response_type') !== 'code') return 'unsupported_response_type'
    if (!q.get('redirect_uri')) return 'redirect_uri_mismatch'
    if (!(q.get('scope') ?? '').split(/\s+/).includes(SCOPE_UPLOAD)) return 'invalid_scope'
    const challenge = q.get('code_challenge')
    const method = q.get('code_challenge_method') ?? 'plain'
    if (requirePkce && !challenge) return 'invalid_request: code_challenge missing'
    if (challenge && method !== 'S256' && method !== 'plain') return 'invalid_request: code_challenge_method'
    if (requirePkce && method !== 'S256') return 'invalid_request: S256 expected'
    return null
  }

  function back(q: URLSearchParams, params: Record<string, string>): Response {
    const u = new URL(q.get('redirect_uri') as string)
    for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v)
    const st = q.get('state')
    if (st !== null) u.searchParams.set('state', st)
    return redirect(u.toString())
  }

  function approve(q: URLSearchParams): Response {
    const requested = (q.get('scope') ?? '').split(/\s+/)
    const scopes = state.grantedScopes.filter((s) => requested.includes(s))
    const code = '4/fake-' + rand()
    codes.set(code, {
      redirectUri: q.get('redirect_uri') as string,
      challenge: q.get('code_challenge'),
      method: q.get('code_challenge_method') ?? 'plain',
      scopes,
      expiresAt: state.now() + CODE_MS,
      used: false
    })
    return back(q, { code, scope: scopes.join(' ') })
  }

  function authorize(url: URL): Response {
    const q = url.searchParams
    state.calls.push('GET /authorize')
    const bad = checkAuthorize(q)
    if (bad) return new Response(`Error 400: ${bad}`, { status: 400, headers: { 'Content-Type': 'text/plain' } })
    const f = takeFault('authorize')
    if (f) return back(q, { error: f.reason ?? 'access_denied' })
    if (state.autoApprove) return approve(q)
    const decide = (allow: string) => {
      const d = new URLSearchParams(q)
      d.set('allow', allow)
      return `${origin}/o/oauth2/v2/auth/decide?${d}`
    }
    const granted = state.grantedScopes.map((s) => `<li>${escapeHtml(s)}</li>`).join('')
    const html = `<!doctype html><meta charset="utf-8"><title>Fake Google: allow Reel Studio?</title><body style="font-family:sans-serif;max-width:560px;margin:48px auto;line-height:1.5"><h1>Fake Google</h1><p>Reel Studio (staging test) wants to:</p><ul>${granted}</ul><p>Channel: ${escapeHtml(state.channel?.title ?? '(none)')}</p><p><a id="allow" href="${escapeHtml(decide('1'))}">Allow</a> &nbsp; <a id="cancel" href="${escapeHtml(decide('0'))}">Cancel</a></p></body>`
    return new Response(html, { status: 200, headers: { 'Content-Type': 'text/html; charset=utf-8' } })
  }

  function decide(url: URL): Response {
    const q = new URLSearchParams(url.searchParams)
    const allow = q.get('allow') === '1'
    q.delete('allow')
    state.calls.push(`GET /authorize decide ${allow ? 'allow' : 'cancel'}`)
    const bad = checkAuthorize(q)
    if (bad) return new Response(`Error 400: ${bad}`, { status: 400 })
    return allow ? approve(q) : back(q, { error: 'access_denied' })
  }

  async function token(req: Request): Promise<Response> {
    const form = new URLSearchParams(await req.text())
    const grant = form.get('grant_type') ?? ''
    state.calls.push(`POST /token grant_type=${grant}`)
    if (form.get('client_id') !== clientId || form.get('client_secret') !== clientSecret) return oauthError(401, 'invalid_client', 'The OAuth client was not found.')
    if (grant === 'authorization_code') {
      const f = takeFault('token')
      if (f) return oauthError(f.status ?? 400, f.reason ?? 'invalid_grant')
      const c = codes.get(form.get('code') ?? '')
      if (!c || c.used || c.expiresAt <= state.now() || c.redirectUri !== form.get('redirect_uri')) return oauthError(400, 'invalid_grant', 'Bad Request')
      if (c.challenge) {
        const verifier = form.get('code_verifier') ?? ''
        const ok = c.method === 'S256' ? (await s256(verifier)) === c.challenge : verifier === c.challenge
        if (!ok) return oauthError(400, 'invalid_grant', 'Invalid code verifier.')
      }
      c.used = true
      const refresh = '1//fake-' + rand()
      state.refreshTokens.set(refresh, { scopes: c.scopes, revoked: false })
      return jsonRes({ access_token: issueAccess(refresh, c.scopes), expires_in: ttlSec, refresh_token: refresh, scope: c.scopes.join(' '), token_type: 'Bearer' })
    }
    if (grant === 'refresh_token') {
      const f = takeFault('refresh')
      if (f) return oauthError(f.status ?? 400, f.reason ?? 'invalid_grant')
      const refresh = form.get('refresh_token') ?? ''
      const r = state.refreshTokens.get(refresh)
      if (!r || r.revoked) return oauthError(400, 'invalid_grant', 'Token has been expired or revoked.')
      return jsonRes({ access_token: issueAccess(refresh, r.scopes), expires_in: ttlSec, scope: r.scopes.join(' '), token_type: 'Bearer' })
    }
    return oauthError(400, 'unsupported_grant_type')
  }

  function kill(refresh: string): void {
    const r = state.refreshTokens.get(refresh)
    if (r) r.revoked = true
    for (const [t, a] of state.accessTokens) if (a.refresh === refresh) state.accessTokens.delete(t)
  }

  async function revoke(req: Request, url: URL): Promise<Response> {
    const form = new URLSearchParams(await req.text())
    const t = form.get('token') ?? url.searchParams.get('token') ?? ''
    state.calls.push('POST /revoke')
    state.revoked.push(t)
    const f = takeFault('revoke')
    if (f) return oauthError(f.status ?? 503, f.reason ?? 'backend_error')
    const r = state.refreshTokens.get(t)
    if (r && !r.revoked) {
      kill(t)
      return jsonRes({})
    }
    const a = state.accessTokens.get(t)
    if (a) {
      kill(a.refresh)
      return jsonRes({})
    }
    return oauthError(400, 'invalid_token', 'Token expired or revoked')
  }

  function channels(req: Request, url: URL): Response {
    state.calls.push('GET /channels')
    const f = takeFault('channels')
    if (f) return ytError(f.status ?? 500, f.reason ?? 'backendError')
    const a = liveAccess(req)
    if (!a) return ytError(401, 'authError', 'Invalid Credentials')
    if (url.searchParams.get('mine') !== 'true') return ytError(400, 'missingParameter')
    if (!a.scopes.includes(SCOPE_READONLY)) return ytError(403, 'insufficientPermissions', 'Request had insufficient authentication scopes.')
    const ch = state.channel
    if (!ch) return jsonRes({ kind: 'youtube#channelListResponse', items: [] })
    return jsonRes({ kind: 'youtube#channelListResponse', items: [{ kind: 'youtube#channel', id: ch.id, snippet: { title: ch.title, customUrl: ch.customUrl } }] })
  }

  async function initUpload(req: Request): Promise<Response> {
    state.calls.push('POST /upload init')
    const f = takeFault('init')
    if (f) return ytError(f.status ?? 500, f.reason ?? 'backendError')
    const a = liveAccess(req)
    if (!a) return ytError(401, 'authError', 'Invalid Credentials')
    if (!a.scopes.includes(SCOPE_UPLOAD)) return ytError(403, 'insufficientPermissions')
    if (!state.channel) return ytError(401, 'youtubeSignupRequired')
    if (state.quotaExceeded) return ytError(403, 'quotaExceeded', 'The request cannot be completed because you have exceeded your quota.')
    if (state.uploadLimitExceeded) return ytError(400, 'uploadLimitExceeded')
    const size = Number(req.headers.get('x-upload-content-length'))
    const mime = req.headers.get('x-upload-content-type') ?? ''
    if (!Number.isInteger(size) || size < 1) return ytError(400, 'invalidArgument', 'X-Upload-Content-Length')
    if (!/^video\//.test(mime) && mime !== 'application/octet-stream') return ytError(400, 'invalidArgument', 'X-Upload-Content-Type')
    let metadata: { snippet?: { title?: unknown; description?: unknown }; status?: { privacyStatus?: unknown } }
    try {
      metadata = JSON.parse(await req.text())
    } catch {
      return ytError(400, 'parseError')
    }
    const title = metadata?.snippet?.title
    if (typeof title !== 'string' || !title || [...title].length > 100 || /[<>]/.test(title)) return ytError(400, 'invalidTitle')
    const description = metadata?.snippet?.description
    if (description !== undefined && (typeof description !== 'string' || /[<>]/.test(description))) return ytError(400, 'invalidDescription')
    const id = `u${++uploadCount}`
    const extra = { refresh: a.refresh, chunks: [] as Uint8Array[], video: undefined as unknown }
    uploadExtra.set(id, extra)
    state.uploads.set(id, {
      metadata,
      size,
      mime,
      get bytes() {
        const all = new Uint8Array(extra.chunks.reduce((n, c) => n + c.length, 0))
        let o = 0
        for (const c of extra.chunks) {
          all.set(c, o)
          o += c.length
        }
        return all
      },
      received: 0,
      done: false
    })
    const location = `${origin}/upload/youtube/v3/videos?uploadType=resumable&upload_id=${id}&part=snippet,status`
    return new Response(null, { status: 200, headers: { Location: location, 'X-GUploader-UploadID': id } })
  }

  function finished(id: string): Response {
    return jsonRes(uploadExtra.get(id)!.video, 201)
  }

  function inProgress(u: FakeUpload): Response {
    return new Response(null, { status: 308, headers: u.received > 0 ? { Range: `bytes=0-${u.received - 1}` } : {} })
  }

  async function session(req: Request, id: string): Promise<Response> {
    const u = state.uploads.get(id)
    const extra = uploadExtra.get(id)
    if (!u || !extra || u.expired) {
      state.calls.push(`PUT upload ${id} (gone)`)
      return ytError(404, 'notFound')
    }
    const a = liveAccess(req)
    if (!a || a.refresh !== extra.refresh) {
      state.calls.push(`PUT upload ${id} (unauthorized)`)
      return ytError(401, 'authError', 'Invalid Credentials')
    }
    const range = req.headers.get('content-range') ?? ''
    const status = /^bytes \*\/(\d+)$/.exec(range)
    if (status) {
      state.calls.push(`PUT upload ${id} status`)
      const f = takeFault('status')
      if (f) return ytError(f.status ?? 503, f.reason ?? 'backendError')
      return u.done ? finished(id) : inProgress(u)
    }
    const m = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(range)
    if (!m) return ytError(400, 'invalidRange')
    const [first, last, total] = [Number(m[1]), Number(m[2]), Number(m[3])]
    state.calls.push(`PUT upload ${id} bytes ${first}-${last}/${total}`)
    if (u.done) return finished(id)
    const body = new Uint8Array(await req.arrayBuffer())
    const f = takeFault('chunk')
    if (f && f.dropAfterBytes !== undefined) {
      const keep = Math.floor(Math.min(f.dropAfterBytes, body.length) / GRAIN) * GRAIN
      if (first === u.received && keep > 0) {
        extra.chunks.push(body.slice(0, keep))
        u.received += keep
      }
      throw new TypeError('network')
    }
    if (f) return ytError(f.status ?? 503, f.reason ?? 'backendError')
    if (total !== u.size || first !== u.received || last < first || last >= u.size) return ytError(400, 'invalidRange', `expected a chunk from ${u.received}`)
    const length = last - first + 1
    if (body.length !== length) return ytError(400, 'invalidRange', 'body length')
    if (length % GRAIN !== 0 && last !== u.size - 1) return ytError(400, 'invalidRange', 'not a multiple of 256 KiB')
    extra.chunks.push(body)
    u.received += length
    if (u.received < u.size) return inProgress(u)
    u.done = true
    u.videoId = 'v' + String(++videoCount).padStart(10, '0')
    const meta = u.metadata as { snippet?: { title?: string; description?: string }; status?: { privacyStatus?: string } }
    const ch = state.channel
    extra.video = {
      kind: 'youtube#video',
      id: u.videoId,
      snippet: { title: meta.snippet?.title, description: meta.snippet?.description ?? '', channelId: ch?.id, channelTitle: ch?.title },
      status: { uploadStatus: 'uploaded', privacyStatus: meta.status?.privacyStatus ?? 'public' }
    }
    return finished(id)
  }

  async function handle(req: Request): Promise<Response> {
    const url = new URL(req.url)
    const p = url.pathname
    if (p === '/o/oauth2/v2/auth' && req.method === 'GET') return authorize(url)
    if (p === '/o/oauth2/v2/auth/decide' && req.method === 'GET') return decide(url)
    if (p === '/token' && req.method === 'POST') return token(req)
    if (p === '/revoke' && req.method === 'POST') return revoke(req, url)
    if (p === '/youtube/v3/channels' && req.method === 'GET') return channels(req, url)
    if (p === '/upload/youtube/v3/videos') {
      const id = url.searchParams.get('upload_id')
      if (req.method === 'POST' && url.searchParams.get('uploadType') === 'resumable' && !id) return initUpload(req)
      if (req.method === 'PUT' && id) return session(req, id)
    }
    return ytError(404, 'notFound', `fake Google has no ${req.method} ${p}`)
  }

  const fakeFetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const req = input instanceof Request && !init ? input : new Request(input as string, init)
    const target = new URL(req.url)
    if (target.origin !== origin) throw new TypeError(`fake Google: refusing a request to ${target.origin}`)
    return handle(req)
  }) as typeof fetch

  return {
    origin,
    fetch: fakeFetch,
    handle,
    env: {
      GOOGLE_AUTH_URL: `${origin}/o/oauth2/v2/auth`,
      GOOGLE_TOKEN_URL: `${origin}/token`,
      GOOGLE_REVOKE_URL: `${origin}/revoke`,
      YOUTUBE_API_URL: `${origin}/youtube/v3`,
      YOUTUBE_UPLOAD_URL: `${origin}/upload/youtube/v3/videos`,
      GOOGLE_CLIENT_ID: clientId,
      GOOGLE_CLIENT_SECRET: clientSecret
    },
    state,
    expireUpload(id: string) {
      const u = state.uploads.get(id)
      if (u) u.expired = true
    },
    revokeAll() {
      for (const t of state.refreshTokens.keys()) kill(t)
    },
    summary() {
      const uploads = [...state.uploads.entries()].map(([id, u]) => {
        const meta = u.metadata as { snippet?: { title?: string }; status?: { privacyStatus?: string } }
        return { id, size: u.size, received: u.received, done: u.done, expired: !!u.expired, videoId: u.videoId ?? null, title: meta?.snippet?.title ?? null, privacy: meta?.status?.privacyStatus ?? null }
      })
      const refresh = [...state.refreshTokens.values()]
      return {
        origin,
        uploads,
        tokens: { live: refresh.filter((r) => !r.revoked).length, revoked: refresh.filter((r) => r.revoked).length },
        revokeCalls: state.revoked.length,
        channel: state.channel,
        calls: state.calls.slice(-50)
      }
    }
  }
}
