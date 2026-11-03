// Sessions: the app trades the purchase key for a per-computer session once, then sends only the session.
//
// A session token is `ps1_` + base64url of 32 random bytes; D1 keeps only its SHA-256. A purchase holds at most
// MAX_SESSIONS (the one used longest ago is dropped). Sign out deletes this computer's session; sign out
// everywhere deletes them all. The YouTube connection belongs to the purchase and stays.
//
// Every use checks the purchase again (`entitlement()` from the downloads Worker), with a 60-second cache per
// isolate when Deps has one.
import { entitlement, getPurchase } from '../../worker/src/records'
import { hmac, verifyToken } from '../../worker/src/token'
import type { Deps, Env } from './app'
import { hex, newId, randomToken, sha256hex } from './crypto'
import { SESSION_LIMIT, connectionJson, limited, readOnly, type ConnectionRow, type SessionRow } from './db'
import { bearer, badRequest, fail, json, notConfigured, readJson, short, tooMany } from './http'

export const MAX_SESSIONS = 10
export const SESSION_PREFIX = 'ps1_'
export const ENTITLEMENT_CACHE_MS = 60_000
const TOUCH_EVERY_MS = 3600_000
const DEVICES = new Set(['Windows', 'Mac', 'Linux'])

export type NotEntitledReason = 'subscription ended' | 'refunded' | 'disputed' | 'unknown purchase'

/** null if the purchase is entitled, otherwise why not. Cached per isolate for a minute (Deps.entitlementCache). */
export async function entitledReason(env: Env, deps: Deps, sid: string): Promise<NotEntitledReason | null> {
  const now = deps.now()
  const cached = deps.entitlementCache?.get(sid)
  if (cached && now - cached.at < ENTITLEMENT_CACHE_MS) return cached.ok ? null : ((cached.reason as NotEntitledReason) ?? 'unknown purchase')
  const kv = readOnly(env.PURCHASES)
  const rec = await getPurchase(kv, sid)
  const reason: NotEntitledReason | null = !rec ? 'unknown purchase' : await entitlement(kv, rec).then((e) => (e.ok ? null : e.reason))
  if (deps.entitlementCache) {
    if (deps.entitlementCache.size > 5000) deps.entitlementCache.clear()
    deps.entitlementCache.set(sid, reason ? { ok: false, reason, at: now } : { ok: true, at: now })
  }
  return reason
}

export async function requireEntitled(env: Env, deps: Deps, sid: string): Promise<void> {
  const reason = await entitledReason(env, deps, sid)
  if (reason) throw fail(403, 'not_entitled', { reason })
}

/** The session behind `Authorization: Bearer ps1_…`, after the entitlement check (unless `entitled: false`,
 * for the routes that only take something away: signing out, disconnecting, cancelling). */
export async function authenticate(request: Request, env: Env, deps: Deps, opts: { entitled: boolean }): Promise<SessionRow> {
  const token = bearer(request)
  if (!token) throw fail(401, 'no_session')
  if (!token.startsWith(SESSION_PREFIX) || token.length > 200) throw fail(401, 'bad_session')
  const s = await env.DB.prepare('SELECT * FROM sessions WHERE token_hash = ?').bind(await sha256hex(token)).first<SessionRow>()
  if (!s) throw fail(401, 'bad_session')
  if (opts.entitled) await requireEntitled(env, deps, s.sid)
  const now = deps.now()
  if (now - s.last_used_at >= TOUCH_EVERY_MS) {
    await env.DB.prepare('UPDATE sessions SET last_used_at = ? WHERE id = ?').bind(now, s.id).run()
    s.last_used_at = now
  }
  return s
}

function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? 'unknown'
}

/** POST /v1/sessions: `Authorization: Bearer <purchase key>`, body {device}. */
export async function createSession(request: Request, env: Env, deps: Deps): Promise<Response> {
  const secret = env.TOKEN_SECRET && env.TOKEN_SECRET.length >= 16 ? env.TOKEN_SECRET : null
  if (!secret) throw notConfigured('token_secret')
  const now = deps.now()
  // The IP is stored only as a keyed hash (a plain hash of an IPv4 address can be reversed by trying them all),
  // and the row goes once its hour is over (limited() clears ended windows).
  const wait = await limited(env.DB, SESSION_LIMIT, hex(await hmac(secret, `ip:${clientIp(request)}`)).slice(0, 32), now)
  if (wait !== null) throw tooMany('rate_limited', wait)

  const key = bearer(request)
  if (!key) throw fail(401, 'no_key')
  const claims = await verifyToken(secret, key, Math.floor(now / 1000), { ignoreExpiry: true })
  if (!claims) throw fail(401, 'bad_key')
  const body = await readJson(request)
  const device = body.device
  if (typeof device !== 'string' || !DEVICES.has(device)) throw badRequest('device')

  const kv = readOnly(env.PURCHASES)
  const rec = await getPurchase(kv, claims.s)
  if (!rec) throw fail(403, 'not_entitled', { reason: 'unknown purchase' })
  const ent = await entitlement(kv, rec)
  if (!ent.ok) throw fail(403, 'not_entitled', { reason: ent.reason })

  // Keep at most MAX_SESSIONS: drop the ones used longest ago to make room for this one.
  const { results } = await env.DB.prepare('SELECT id FROM sessions WHERE sid = ? ORDER BY last_used_at DESC, created_at DESC').bind(rec.sid).all<{ id: string }>()
  const drop = results.slice(MAX_SESSIONS - 1)
  const session = SESSION_PREFIX + randomToken(32)
  const id = newId('s')
  await env.DB.batch([
    ...drop.map((r) => env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(r.id)),
    env.DB.prepare('INSERT INTO sessions (id, token_hash, sid, plan, device, created_at, last_used_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(
      id,
      await sha256hex(session),
      rec.sid,
      rec.plan,
      device,
      now,
      now
    )
  ])
  console.log(`[posting] session ${short(id)} for ${short(rec.sid)} (${device})${drop.length ? `, dropped ${drop.length} old` : ''}`)
  return json({ session, sessionId: id, plan: rec.plan, device }, 201)
}

/** GET /v1/me */
export async function me(env: Env, s: SessionRow): Promise<Response> {
  const others = await env.DB.prepare('SELECT COUNT(*) AS n FROM sessions WHERE sid = ? AND id != ?').bind(s.sid, s.id).first<{ n: number }>()
  const { results } = await env.DB.prepare('SELECT * FROM connections WHERE sid = ? ORDER BY platform').bind(s.sid).all<ConnectionRow>()
  return json({
    plan: s.plan,
    session: { id: s.id, device: s.device, createdAt: s.created_at },
    otherSessions: others?.n ?? 0,
    connections: results.map(connectionJson)
  })
}

/** DELETE /v1/sessions/current */
export async function signOut(env: Env, s: SessionRow): Promise<Response> {
  await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(s.id).run()
  console.log(`[posting] signed out ${short(s.id)}`)
  return json({ ok: true })
}

/** DELETE /v1/sessions: every computer of this purchase, this one included. Connections stay. */
export async function signOutEverywhere(env: Env, s: SessionRow): Promise<Response> {
  const r = await env.DB.prepare('DELETE FROM sessions WHERE sid = ?').bind(s.sid).run()
  const n = r.meta.changes ?? 0
  console.log(`[posting] signed out everywhere for ${short(s.sid)}: ${n}`)
  return json({ ok: true, signedOut: n })
}
