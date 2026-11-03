// Connecting YouTube: Google's server-side web flow with PKCE, started from the app and finished in the browser.
//
//   1. The app (signed in) POSTs an attempt and opens our own /oauth/youtube/begin?a=…&t=… in the browser.
//      `t` works once: D1 keeps only its SHA-256.
//   2. /begin makes the OAuth `state` and the PKCE verifier, stores them on the attempt (which is bound to the
//      app's session), sets an HttpOnly cookie that only the callback reads, and sends the browser to Google.
//   3. Google sends the browser back to the callback (redirectUri(), registered exactly in Google Cloud). It
//      checks the state, the cookie, the session and the purchase, trades the code, checks the granted scopes,
//      reads the channel, and stores the tokens encrypted. The page says what happened.
//   4. Meanwhile the app polls the attempt every 2 seconds and learns the outcome there.
import type { Deps, Env } from './app'
import { ad, decrypt, encrypt, importEncKey, newId, pkceChallenge, randomToken, sameHash, sha256hex } from './crypto'
import { ATTEMPT_LIMIT, connectionFor, connectionJson, limited, type AttemptRow, type AttemptStatus, type ConnectionRow, type SessionRow } from './db'
import { CALLBACK_PATH, SCOPE_READONLY, SCOPE_UPLOAD, exchangeCode, googleConfigured, myChannel, redirectUri, revoke, urls } from './google'
import { fail, json, notConfigured, short, tooMany } from './http'
import { page, pageHeaders, type PageKind } from './pages'
import { entitledReason } from './sessions'

export const ATTEMPT_MS = 10 * 60_000
export const POLL_MS = 2000
const COOKIE = 'rs_oauth'
const OPEN: AttemptStatus[] = ['waiting', 'opened']

export async function encKeyOr503(env: Env): Promise<CryptoKey> {
  const key = await importEncKey(env.ENC_KEY)
  if (!key) throw notConfigured('enc_key')
  return key
}

function cookie(env: Env, value: string, maxAge: number): string {
  const secure = env.PUBLIC_ORIGIN.startsWith('https:') ? '; Secure' : ''
  return `${COOKIE}=${value}; Path=${CALLBACK_PATH}; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`
}

function readCookie(request: Request, name: string): string | null {
  for (const part of (request.headers.get('cookie') ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=')
    if (k === name) return v.join('=') || null
  }
  return null
}

// ---- the app's side (session routes) ---------------------------------------------------------------------

/** POST /v1/connections/youtube/attempts */
export async function createAttempt(env: Env, deps: Deps, s: SessionRow): Promise<Response> {
  if (!googleConfigured(env)) throw notConfigured('google')
  await encKeyOr503(env)
  const now = deps.now()
  const wait = await limited(env.DB, ATTEMPT_LIMIT, s.sid, now)
  if (wait !== null) throw tooMany('rate_limited', wait)
  const id = newId('a')
  const t = randomToken(32)
  const expiresAt = now + ATTEMPT_MS
  await env.DB.batch([
    // One open attempt per purchase: an earlier one is cancelled (its link then says "expired").
    env.DB.prepare(
      "UPDATE oauth_attempts SET status = 'cancelled', state = NULL, code_verifier = NULL, cookie_hash = NULL WHERE sid = ? AND status IN ('waiting', 'opened')"
    ).bind(s.sid),
    env.DB.prepare(
      "INSERT INTO oauth_attempts (id, sid, session_id, platform, begin_hash, status, created_at, expires_at) VALUES (?, ?, ?, 'youtube', ?, 'waiting', ?, ?)"
    ).bind(id, s.sid, s.id, await sha256hex(t), now, expiresAt)
  ])
  const openUrl = `${env.PUBLIC_ORIGIN.replace(/\/+$/, '')}/oauth/youtube/begin?a=${id}&t=${t}`
  return json({ attemptId: id, openUrl, expiresAt, pollMs: POLL_MS }, 201)
}

async function attemptOf(env: Env, s: SessionRow, id: string): Promise<AttemptRow> {
  const a = /^a_[0-9a-f]{32}$/.test(id) ? await env.DB.prepare('SELECT * FROM oauth_attempts WHERE id = ? AND sid = ?').bind(id, s.sid).first<AttemptRow>() : null
  if (!a) throw fail(404, 'not_found')
  return a
}

/** GET /v1/connections/youtube/attempts/:id */
export async function getAttempt(env: Env, deps: Deps, s: SessionRow, id: string): Promise<Response> {
  const a = await attemptOf(env, s, id)
  if (OPEN.includes(a.status) && a.expires_at <= deps.now()) return json({ status: 'expired' })
  if (a.status === 'connected' && a.connection_id) {
    const c = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind(a.connection_id).first<ConnectionRow>()
    if (c) return json({ status: 'connected', connection: connectionJson(c) })
  }
  return json({ status: a.status })
}

/** DELETE /v1/connections/youtube/attempts/:id */
export async function cancelAttempt(env: Env, s: SessionRow, id: string): Promise<Response> {
  const a = await attemptOf(env, s, id)
  if (OPEN.includes(a.status)) {
    await env.DB.prepare("UPDATE oauth_attempts SET status = 'cancelled', state = NULL, code_verifier = NULL, cookie_hash = NULL WHERE id = ?").bind(a.id).run()
  }
  return json({ ok: true })
}

/** DELETE /v1/connections/youtube: revoke at Google, then forget the connection and its post history. */
export async function disconnect(env: Env, deps: Deps, s: SessionRow): Promise<Response> {
  const c = await connectionFor(env.DB, s.sid)
  if (!c) return json({ ok: true, revoked: false })
  let revoked = false
  if (c.refresh_enc) {
    const key = await encKeyOr503(env)
    revoked = await revokeStored(env, deps, key, c)
  }
  await removeConnection(env, c.id)
  console.log(`[posting] disconnected ${short(c.id)} for ${short(s.sid)}${revoked ? '' : ' (Google did not confirm the revoke)'}`)
  return json({ ok: true, revoked })
}

/** Revoke a connection's refresh token at Google. true when Google said 200. Never throws. */
export async function revokeStored(env: Env, deps: Deps, key: CryptoKey, c: Pick<ConnectionRow, 'id' | 'refresh_enc'>): Promise<boolean> {
  if (!c.refresh_enc) return false
  let token: string
  try {
    token = await decrypt(key, c.refresh_enc, ad.refresh(c.id))
  } catch {
    console.error(`[posting] connection ${short(c.id)}: the refresh token does not decrypt (ENC_KEY changed?)`)
    return false
  }
  return revoke(env, deps, token)
}

export async function removeConnection(env: Env, connectionId: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM uploads WHERE connection_id = ?').bind(connectionId),
    env.DB.prepare('DELETE FROM connections WHERE id = ?').bind(connectionId)
  ])
}

// ---- the browser's side ----------------------------------------------------------------------------------

/** GET /oauth/youtube/begin?a=…&t=… */
export async function begin(url: URL, env: Env, deps: Deps): Promise<Response> {
  const show = (kind: PageKind) => page(kind, { siteOrigin: env.SITE_ORIGIN })
  const id = url.searchParams.get('a') ?? ''
  const t = url.searchParams.get('t') ?? ''
  if (!/^a_[0-9a-f]{32}$/.test(id) || !t || t.length > 100) return show('expired')
  const a = await env.DB.prepare('SELECT * FROM oauth_attempts WHERE id = ?').bind(id).first<AttemptRow>()
  const now = deps.now()
  if (!a || a.status !== 'waiting' || a.expires_at <= now || !sameHash(a.begin_hash, await sha256hex(t))) return show('expired')
  if (!googleConfigured(env)) return show('failed')

  const state = randomToken(32)
  const pkce = env.OAUTH_PKCE !== 'off'
  const verifier = pkce ? randomToken(32) : null
  const cookieValue = randomToken(32)
  const r = await env.DB.prepare("UPDATE oauth_attempts SET status = 'opened', state = ?, code_verifier = ?, cookie_hash = ? WHERE id = ? AND status = 'waiting'")
    .bind(state, verifier, await sha256hex(cookieValue), a.id)
    .run()
  if ((r.meta.changes ?? 0) !== 1) return show('expired')

  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID!,
    redirect_uri: redirectUri(env),
    response_type: 'code',
    scope: `${SCOPE_UPLOAD} ${SCOPE_READONLY}`,
    access_type: 'offline',
    // The account chooser too, so someone who connected the wrong Google account can pick another one.
    prompt: 'select_account consent',
    state
  })
  if (verifier) {
    params.set('code_challenge', await pkceChallenge(verifier))
    params.set('code_challenge_method', 'S256')
  }
  return new Response(null, {
    status: 302,
    headers: { ...pageHeaders(), Location: `${urls(env).auth}?${params}`, 'Set-Cookie': cookie(env, cookieValue, ATTEMPT_MS / 1000) }
  })
}

/** GET <CALLBACK_PATH>?state=…&code=… (or &error=access_denied) */
export async function callback(request: Request, url: URL, env: Env, deps: Deps): Promise<Response> {
  const clear = { 'Set-Cookie': cookie(env, '', 0) }
  const show = (kind: PageKind, channelName?: string | null) => page(kind, { siteOrigin: env.SITE_ORIGIN, channelName, headers: clear })
  const state = url.searchParams.get('state') ?? ''
  if (!state || state.length > 100) return show('expired')
  const a = await env.DB.prepare('SELECT * FROM oauth_attempts WHERE state = ?').bind(state).first<AttemptRow>()
  const now = deps.now()
  if (!a || a.status !== 'opened' || a.expires_at <= now) return show('expired')
  // A different browser (or a link someone else started) has no cookie, or the wrong one. The attempt stays open.
  const cookieValue = readCookie(request, COOKIE)
  if (!cookieValue || !sameHash(a.cookie_hash, await sha256hex(cookieValue))) return show('expired')

  // Take the attempt: from here on the same state can't be used again.
  const took = await env.DB.prepare('UPDATE oauth_attempts SET state = NULL, cookie_hash = NULL WHERE id = ? AND state = ?').bind(a.id, state).run()
  if ((took.meta.changes ?? 0) !== 1) return show('expired')
  const finish = async (status: AttemptStatus, connectionId: string | null = null) => {
    await env.DB.prepare('UPDATE oauth_attempts SET status = ?, connection_id = ?, state = NULL, code_verifier = NULL, cookie_hash = NULL WHERE id = ?')
      .bind(status, connectionId, a.id)
      .run()
    if (status !== 'connected') console.log(`[posting] connect ${short(a.id)} for ${short(a.sid)}: ${status}`)
  }

  const session = await env.DB.prepare('SELECT id FROM sessions WHERE id = ?').bind(a.session_id).first()
  if (!session) {
    await finish('cancelled')
    return show('expired')
  }
  if (await entitledReason(env, deps, a.sid)) {
    await finish('failed')
    return show('not_entitled')
  }
  const error = url.searchParams.get('error')
  if (error) {
    const outcome = error === 'access_denied' ? 'denied' : 'failed'
    await finish(outcome)
    return show(outcome)
  }
  const code = url.searchParams.get('code')
  const key = await importEncKey(env.ENC_KEY)
  if (!code || !googleConfigured(env) || !key) {
    await finish('failed')
    return show('failed')
  }

  const tokens = await exchangeCode(env, deps, code, a.code_verifier)
  if (!tokens?.refresh_token) {
    if (tokens) await revoke(env, deps, tokens.access_token)
    await finish('failed')
    return show('failed')
  }
  const refreshToken = tokens.refresh_token
  const scopes = tokens.scope.split(/\s+/).filter(Boolean)
  if (!scopes.includes(SCOPE_UPLOAD)) {
    await revoke(env, deps, refreshToken)
    await finish('missing_permission')
    return show('missing_permission')
  }
  const ch = await myChannel(env, deps, tokens.access_token)
  if (ch.kind === 'none') {
    await revoke(env, deps, refreshToken)
    await finish('no_channel')
    return show('no_channel')
  }
  if (ch.kind === 'error') {
    console.error(`[posting] channels.list ${ch.status} ${ch.reason}`)
    await revoke(env, deps, refreshToken)
    await finish('failed')
    return show('failed')
  }
  // 'forbidden': youtube.readonly was unticked. Connect anyway, without the channel's name.
  const channel = ch.kind === 'channel' ? ch.channel : null

  // One YouTube connection per purchase: the old one is revoked and forgotten, with its post history. Not when
  // it is the same channel: that is the same Google grant, and revoking it would end the new one too.
  const old = await connectionFor(env.DB, a.sid)
  if (old?.refresh_enc && !(old.channel_id && channel && old.channel_id === channel.id)) await revokeStored(env, deps, key, old)

  const id = newId('c')
  await env.DB.batch([
    ...(old
      ? [env.DB.prepare('DELETE FROM uploads WHERE connection_id = ?').bind(old.id), env.DB.prepare('DELETE FROM connections WHERE id = ?').bind(old.id)]
      : []),
    env.DB.prepare(
      `INSERT INTO connections (id, sid, platform, status, scopes, channel_id, channel_name, channel_handle, channel_checked_at, refresh_enc, access_enc, access_expires_at, created_at, updated_at)
       VALUES (?, ?, 'youtube', 'connected', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id,
      a.sid,
      scopes.join(' '),
      channel?.id ?? null,
      channel?.title ?? null,
      channel?.handle ?? null,
      now,
      await encrypt(key, refreshToken, ad.refresh(id)),
      await encrypt(key, tokens.access_token, ad.access(id)),
      now + tokens.expires_in * 1000,
      now,
      now
    )
  ])
  await finish('connected', id)
  console.log(`[posting] connected ${short(id)} for ${short(a.sid)}${channel ? '' : ' (channel unknown)'}${old ? `, replaced ${short(old.id)}` : ''}`)
  return show('connected', channel?.title ?? null)
}
