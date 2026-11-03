// Everything that talks to Google: the OAuth token endpoint, revocation, channels.list, and fresh access tokens
// for a connection. Every call goes through Deps.fetch, so tests use the fake Google (test/fake-google.ts).
//
// Endpoint URLs come from optional vars that default to Google's own; only tests and local runs set them.
import type { Deps, Env } from './app'
import { ad, decrypt, encrypt } from './crypto'
import type { ConnectionRow } from './db'
import { fail, platformError, short } from './http'

export const SCOPE_UPLOAD = 'https://www.googleapis.com/auth/youtube.upload'
export const SCOPE_READONLY = 'https://www.googleapis.com/auth/youtube.readonly'
/** Refresh an access token when less than this is left. */
export const ACCESS_MARGIN_MS = 5 * 60_000

export function urls(env: Env) {
  return {
    auth: env.GOOGLE_AUTH_URL || 'https://accounts.google.com/o/oauth2/v2/auth',
    token: env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token',
    revoke: env.GOOGLE_REVOKE_URL || 'https://oauth2.googleapis.com/revoke',
    api: (env.YOUTUBE_API_URL || 'https://www.googleapis.com/youtube/v3').replace(/\/+$/, ''),
    upload: env.YOUTUBE_UPLOAD_URL || 'https://www.googleapis.com/upload/youtube/v3/videos'
  }
}

export function googleConfigured(env: Env): boolean {
  return !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET)
}

/** The OAuth redirect URI, registered exactly in the Google Cloud client. */
export const CALLBACK_PATH = '/v1/youtube/callback'
export function redirectUri(env: Env): string {
  return env.PUBLIC_ORIGIN.replace(/\/+$/, '') + CALLBACK_PATH
}

/** The `reason` of a YouTube error answer (`{error:{errors:[{reason}]}}`), or the OAuth `error` string. */
export async function errorReason(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    const e = body?.error
    if (typeof e === 'string') return e
    const reason = (e as { errors?: Array<{ reason?: unknown }> })?.errors?.[0]?.reason
    if (typeof reason === 'string') return reason
    const status = (e as { status?: unknown })?.status
    return typeof status === 'string' ? status : ''
  } catch {
    return ''
  }
}

/** fetch, with a network failure turned into `502 platform_error retry:true`. */
export async function call(deps: Deps, url: string, init: RequestInit): Promise<Response> {
  try {
    return await deps.fetch(url, init)
  } catch (e) {
    console.error(`[posting] google ${init.method ?? 'GET'} ${new URL(url).pathname}: ${String((e as Error)?.message ?? e).slice(0, 200)}`)
    throw platformError(true)
  }
}

function form(fields: Record<string, string>): RequestInit {
  return { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(fields).toString() }
}

export interface Tokens {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope: string
}

function parseTokens(v: unknown): Tokens | null {
  const t = v as Partial<Tokens>
  if (!t || typeof t.access_token !== 'string' || !t.access_token) return null
  return {
    access_token: t.access_token,
    refresh_token: typeof t.refresh_token === 'string' && t.refresh_token ? t.refresh_token : undefined,
    expires_in: typeof t.expires_in === 'number' && t.expires_in > 0 ? t.expires_in : 3600,
    scope: typeof t.scope === 'string' ? t.scope : ''
  }
}

/** Trade the authorization code. null on any failure (the attempt becomes `failed`). */
export async function exchangeCode(env: Env, deps: Deps, code: string, verifier: string | null): Promise<Tokens | null> {
  const fields: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: env.GOOGLE_CLIENT_ID!,
    client_secret: env.GOOGLE_CLIENT_SECRET!,
    redirect_uri: redirectUri(env)
  }
  if (verifier) fields.code_verifier = verifier
  let res: Response
  try {
    res = await deps.fetch(urls(env).token, form(fields))
  } catch {
    return null
  }
  if (!res.ok) {
    console.error(`[posting] code exchange ${res.status} ${await errorReason(res)}`)
    return null
  }
  return parseTokens(await res.json().catch(() => null))
}

export type Refreshed = { kind: 'ok'; tokens: Tokens } | { kind: 'invalid_grant' } | { kind: 'error'; retry: boolean }

export async function refreshAccess(env: Env, deps: Deps, refreshToken: string): Promise<Refreshed> {
  let res: Response
  try {
    res = await deps.fetch(urls(env).token, form({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: env.GOOGLE_CLIENT_ID!, client_secret: env.GOOGLE_CLIENT_SECRET! }))
  } catch {
    return { kind: 'error', retry: true }
  }
  if (res.ok) {
    const tokens = parseTokens(await res.json().catch(() => null))
    return tokens ? { kind: 'ok', tokens } : { kind: 'error', retry: false }
  }
  const reason = await errorReason(res)
  if (reason === 'invalid_grant') return { kind: 'invalid_grant' }
  console.error(`[posting] refresh ${res.status} ${reason}`)
  return { kind: 'error', retry: res.status >= 500 }
}

/** POST the revoke endpoint. true when Google said 200; 400 means the token was already dead. Never throws. */
export async function revoke(env: Env, deps: Deps, token: string): Promise<boolean> {
  try {
    const res = await deps.fetch(urls(env).revoke, form({ token }))
    return res.status === 200
  } catch {
    return false
  }
}

export interface Channel {
  id: string
  title: string | null
  handle: string | null
}

/** `channels.list?mine=true`. `forbidden`: the token can't read the channel (youtube.readonly unticked). */
export type ChannelResult = { kind: 'channel'; channel: Channel } | { kind: 'none' } | { kind: 'forbidden' } | { kind: 'error'; status: number; reason: string }

export async function myChannel(env: Env, deps: Deps, accessToken: string): Promise<ChannelResult> {
  let res: Response
  try {
    res = await deps.fetch(`${urls(env).api}/channels?part=snippet&mine=true`, { headers: { Authorization: `Bearer ${accessToken}` } })
  } catch {
    return { kind: 'error', status: 0, reason: 'network' }
  }
  if (res.status === 200) {
    const body = (await res.json().catch(() => null)) as { items?: Array<{ id?: unknown; snippet?: { title?: unknown; customUrl?: unknown } }> } | null
    const item = body?.items?.[0]
    if (!item || typeof item.id !== 'string') return { kind: 'none' }
    const title = typeof item.snippet?.title === 'string' ? item.snippet.title.slice(0, 200) : null
    const custom = typeof item.snippet?.customUrl === 'string' ? item.snippet.customUrl : ''
    return { kind: 'channel', channel: { id: item.id, title, handle: custom.startsWith('@') ? custom.slice(0, 120) : null } }
  }
  const reason = await errorReason(res)
  if (res.status === 401 && reason === 'youtubeSignupRequired') return { kind: 'none' }
  if (res.status === 403) return { kind: 'forbidden' }
  return { kind: 'error', status: res.status, reason }
}

/** invalid_grant: the grant is gone (the 7-day Testing expiry, or removed in Google's settings). The connection
 * needs connecting again; what it held from that grant goes now. */
export async function markReconnect(env: Env, deps: Deps, c: ConnectionRow): Promise<void> {
  await env.DB.prepare(
    "UPDATE connections SET status = 'reconnect', refresh_enc = NULL, access_enc = NULL, access_expires_at = NULL, channel_id = NULL, channel_name = NULL, channel_handle = NULL, updated_at = ? WHERE id = ?"
  )
    .bind(deps.now(), c.id)
    .run()
  console.log(`[posting] connection ${short(c.id)} needs reconnecting (invalid_grant)`)
}

/** A usable access token for this connection: the cached one while more than 5 minutes are left, else a fresh
 * one (cached encrypted). `force` refreshes even so (after Google answered 401). Throws the contract's errors. */
export async function accessToken(env: Env, deps: Deps, key: CryptoKey, c: ConnectionRow, force = false): Promise<string> {
  if (c.status !== 'connected' || !c.refresh_enc) throw fail(409, 'reconnect_needed')
  const now = deps.now()
  if (!force && c.access_enc && (c.access_expires_at ?? 0) - now > ACCESS_MARGIN_MS) {
    try {
      return await decrypt(key, c.access_enc, ad.access(c.id))
    } catch {
      // Fall through and refresh.
    }
  }
  const refreshToken = await decrypt(key, c.refresh_enc, ad.refresh(c.id))
  const r = await refreshAccess(env, deps, refreshToken)
  if (r.kind === 'invalid_grant') {
    await markReconnect(env, deps, c)
    throw fail(409, 'reconnect_needed')
  }
  if (r.kind === 'error') throw platformError(r.retry)
  const accessEnc = await encrypt(key, r.tokens.access_token, ad.access(c.id))
  const expires = now + r.tokens.expires_in * 1000
  await env.DB.prepare('UPDATE connections SET access_enc = ?, access_expires_at = ?, updated_at = ? WHERE id = ?').bind(accessEnc, expires, now, c.id).run()
  c.access_enc = accessEnc
  c.access_expires_at = expires
  return r.tokens.access_token
}
