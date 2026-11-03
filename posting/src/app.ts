// post.getreelstudio.com: the Worker that posts a finished reel to the buyer's YouTube channel. (index.ts is the
// entry; this module holds the routes.) The app talks to it from its main process; Google's tokens never leave
// this server.
//
//   GET    /v1/health                            no auth: is it up, and is YouTube configured
//   POST   /v1/sessions                          the purchase key (Bearer) → a session for this computer
//   GET    /v1/me                                plan, this session, other computers, connections
//   DELETE /v1/sessions/current                  sign out this computer
//   DELETE /v1/sessions                          sign out everywhere (the YouTube connection stays)
//   POST   /v1/connections/youtube/attempts      start connecting: answers the page for the browser to open
//   GET    /v1/connections/youtube/attempts/:id  the app polls this until the browser is done
//   DELETE /v1/connections/youtube/attempts/:id  stop waiting
//   DELETE /v1/connections/youtube               disconnect: revoke at Google, forget the tokens and the post history
//   POST   /v1/uploads                           open a YouTube upload session
//   PUT    /v1/uploads/:id                       one chunk, forwarded to Google
//   GET    /v1/uploads/:id                       how much Google has (or the video, once done)
//   DELETE /v1/uploads/:id                       cancel
//   GET    /oauth/youtube/begin?a=…&t=…          the browser: sets a cookie, sends it on to Google
//   GET    /v1/youtube/callback                  the browser, back from Google (the registered redirect URI)
//
// Every /v1/ route but health, the session trade and the callback takes `Authorization: Bearer <session>`, and
// every one that can post or connect checks the purchase is still entitled (sessions.ts). Errors are always
// `{"error": "<snake_case>", …}`. The page never sees the purchase key or the session: the app's main process does.
import { authenticate, createSession, me, signOut, signOutEverywhere } from './sessions'
import { cancelAttempt, callback, begin, createAttempt, disconnect, getAttempt } from './oauth'
import { CALLBACK_PATH, googleConfigured } from './google'
import { ApiError, fail, json, notConfigured } from './http'
import { cancelUpload, createUpload, getUpload, putChunk } from './uploads'

export interface Env {
  /** The downloads Worker's purchases (same namespace id). Read only (db.ts readOnly). */
  PURCHASES: KVNamespace
  DB: D1Database
  /** This Worker's own origin, for the OAuth redirect URI: https://post-staging.getreelstudio.com */
  PUBLIC_ORIGIN: string
  SITE_ORIGIN: string
  /** Secrets */
  TOKEN_SECRET?: string // the SAME value as the downloads Worker of the same environment
  ENC_KEY?: string // base64url(32 random bytes)
  GOOGLE_CLIENT_ID?: string
  GOOGLE_CLIENT_SECRET?: string
  /** Optional vars; unset = Google's real endpoints. Tests and local runs point them at the fake. Never set in staging/production config. */
  GOOGLE_AUTH_URL?: string // https://accounts.google.com/o/oauth2/v2/auth
  GOOGLE_TOKEN_URL?: string // https://oauth2.googleapis.com/token
  GOOGLE_REVOKE_URL?: string // https://oauth2.googleapis.com/revoke
  YOUTUBE_API_URL?: string // https://www.googleapis.com/youtube/v3
  YOUTUBE_UPLOAD_URL?: string // https://www.googleapis.com/upload/youtube/v3/videos
  OAUTH_PKCE?: string // "off" drops PKCE; anything else = S256
}

export interface Deps {
  /** Every Google call goes through this (tests: the fake's fetch). */
  fetch: typeof fetch
  /** ms since 1970 */
  now(): number
  /** Per-isolate entitlement answers, kept 60 s. Absent (tests) = no cache. */
  entitlementCache?: Map<string, { ok: boolean; reason?: string; at: number }>
}

const ATTEMPT_RE = /^\/v1\/connections\/youtube\/attempts\/([^/]+)$/
const UPLOAD_RE = /^\/v1\/uploads\/([^/]+)$/

export async function handle(request: Request, env: Env, deps: Deps): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  const method = request.method
  try {
    // `return await`: a rejected route must land in this catch, not escape as an unhandled rejection.
    if (path === '/v1/health' && method === 'GET') return json({ ok: true, youtube: googleConfigured(env) })
    if (path === '/' && method === 'GET') return Response.redirect(`${env.SITE_ORIGIN}/`, 302)
    if (!env.DB) throw notConfigured('db')
    if (path === '/oauth/youtube/begin' && method === 'GET') return await begin(url, env, deps)
    if (path === CALLBACK_PATH && method === 'GET') return await callback(request, url, env, deps)
    if (path === '/v1/sessions' && method === 'POST') return await createSession(request, env, deps)
    if (path.startsWith('/v1/')) return await sessionRoute(request, url, env, deps)
    throw fail(404, 'not_found')
  } catch (e) {
    if (e instanceof ApiError) return json(e.body, e.status, e.headers)
    console.error(`[posting] ${method} ${path} (app ${request.headers.get('x-reel-studio-version') ?? '?'}): ${String((e as Error)?.stack ?? e).slice(0, 500)}`)
    return json({ error: 'server_error' }, 500)
  }
}

/** The routes behind a session. The ones that only take something away (sign out, disconnect, cancel) work
 * even after the subscription ended, so nobody is stuck with access they want gone. */
async function sessionRoute(request: Request, url: URL, env: Env, deps: Deps): Promise<Response> {
  const path = url.pathname
  const method = request.method
  const takesAway = method === 'DELETE'
  const s = await authenticate(request, env, deps, { entitled: !takesAway })

  if (path === '/v1/me' && method === 'GET') return me(env, s)
  if (path === '/v1/sessions/current' && method === 'DELETE') return signOut(env, s)
  if (path === '/v1/sessions' && method === 'DELETE') return signOutEverywhere(env, s)
  if (path === '/v1/connections/youtube/attempts' && method === 'POST') return createAttempt(env, deps, s)
  if (path === '/v1/connections/youtube' && method === 'DELETE') return disconnect(env, deps, s)
  const attempt = ATTEMPT_RE.exec(path)
  if (attempt && method === 'GET') return getAttempt(env, deps, s, attempt[1])
  if (attempt && method === 'DELETE') return cancelAttempt(env, s, attempt[1])
  if (path === '/v1/uploads' && method === 'POST') return createUpload(request, env, deps, s)
  const upload = UPLOAD_RE.exec(path)
  if (upload && method === 'PUT') return putChunk(request, env, deps, s, upload[1])
  if (upload && method === 'GET') return getUpload(env, deps, s, upload[1])
  if (upload && method === 'DELETE') return cancelUpload(env, deps, s, upload[1])
  throw fail(404, 'not_found')
}
