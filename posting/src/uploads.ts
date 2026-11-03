// Uploads: the app sends the video to us in chunks and we forward each one to YouTube's resumable upload
// session with the connection's access token. One chunk is in memory at a time (at most MAX_CHUNK), never the
// whole file, and nothing is kept once it is forwarded. Titles and descriptions go to YouTube and aren't stored.
//
// Google is the truth about how much arrived: `received` is what its last answer confirmed, and the app always
// continues from the `received` we answer, never from its own count (a dropped connection can leave Google with
// part of a chunk). GET asks Google again.
import type { Deps, Env } from './app'
import { ad, decrypt, encrypt, newId } from './crypto'
import { UPLOAD_LIMIT, connectionFor, limited, type ConnectionRow, type SessionRow, type UploadRow } from './db'
import { accessToken, call, errorReason, googleConfigured, urls } from './google'
import { badRequest, fail, json, notConfigured, platformError, readJson, short, tooMany, type ApiError } from './http'
import { encKeyOr503 } from './oauth'

export const CHUNK_SIZE = 8 * 1024 * 1024
export const MAX_CHUNK = 16 * 1024 * 1024
/** Every chunk but the last is a multiple of this (Google's rule). */
export const GRAIN = 256 * 1024
export const MAX_SIZE = 4 * 1024 * 1024 * 1024
const MIME_TYPES = new Set(['video/mp4', 'video/quicktime'])
const PRIVACY = new Set(['private', 'unlisted', 'public'])
const enc = new TextEncoder()

/** YouTube's daily quota resets at midnight Pacific time; near enough, 08:00 UTC. */
function secondsToQuotaReset(nowMs: number): number {
  const d = new Date(nowMs)
  let reset = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 8)
  if (reset <= nowMs) reset += 86400_000
  return Math.ceil((reset - nowMs) / 1000)
}

/** A session address Google hands back is used only if it is Google's (or the configured fake's). */
export function acceptableSessionUri(env: Env, location: string): boolean {
  let u: URL
  try {
    u = new URL(location)
  } catch {
    return false
  }
  if (u.protocol === 'https:' && (u.hostname === 'googleapis.com' || u.hostname.endsWith('.googleapis.com'))) return true
  return u.origin === new URL(urls(env).upload).origin
}

/** A YouTube error answer as the contract's error. Called after the 401 retry. */
async function youtubeError(res: Response, nowMs: number): Promise<ApiError> {
  if (res.status >= 500) return platformError(true)
  const reason = await errorReason(res)
  switch (reason) {
    case 'quotaExceeded':
      return tooMany('quota', secondsToQuotaReset(nowMs))
    case 'uploadLimitExceeded':
      return tooMany('upload_limit', secondsToQuotaReset(nowMs))
    case 'youtubeSignupRequired':
      return fail(409, 'no_channel')
    case 'invalidTitle':
      return badRequest('title')
    case 'invalidDescription':
      return badRequest('description')
    case 'forbiddenPrivacySetting':
    case 'invalidPrivacyStatus':
      return badRequest('privacy')
  }
  console.error(`[posting] youtube ${res.status} ${reason || '(no reason)'}`)
  return platformError(false)
}

// ---- POST /v1/uploads ------------------------------------------------------------------------------------

interface NewUpload {
  size: number
  mimeType: string
  title: string
  description: string
  privacy: string
  madeForKids: boolean
}

function validate(b: Record<string, unknown>): NewUpload {
  if (b.platform !== 'youtube') throw badRequest()
  const size = b.size
  if (typeof size !== 'number' || !Number.isInteger(size) || size < 1 || size > MAX_SIZE) throw badRequest('size')
  if (typeof b.mimeType !== 'string' || !MIME_TYPES.has(b.mimeType)) throw badRequest()
  const title = typeof b.title === 'string' ? b.title.trim() : ''
  const titleLength = [...title].length
  if (titleLength < 1 || titleLength > 100 || /[<>]/.test(title)) throw badRequest('title')
  const description = b.description === undefined ? '' : b.description
  if (typeof description !== 'string' || enc.encode(description).length > 5000 || /[<>]/.test(description)) throw badRequest('description')
  if (typeof b.privacy !== 'string' || !PRIVACY.has(b.privacy)) throw badRequest('privacy')
  if (typeof b.madeForKids !== 'boolean') throw badRequest()
  return { size, mimeType: b.mimeType, title, description, privacy: b.privacy, madeForKids: b.madeForKids }
}

export async function createUpload(request: Request, env: Env, deps: Deps, s: SessionRow): Promise<Response> {
  const v = validate(await readJson(request))
  if (!googleConfigured(env)) throw notConfigured('google')
  const key = await encKeyOr503(env)
  const conn = await connectionFor(env.DB, s.sid)
  if (!conn) throw fail(409, 'not_connected')
  if (conn.status !== 'connected') throw fail(409, 'reconnect_needed')
  const now = deps.now()
  const wait = await limited(env.DB, UPLOAD_LIMIT, s.sid, now)
  if (wait !== null) throw tooMany('rate_limited', wait)

  const metadata = JSON.stringify({
    snippet: { title: v.title, description: v.description, categoryId: '22' },
    status: { privacyStatus: v.privacy, selfDeclaredMadeForKids: v.madeForKids }
  })
  const init = (token: string) =>
    call(deps, `${urls(env).upload}?uploadType=resumable&part=snippet,status`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json; charset=UTF-8',
        'X-Upload-Content-Length': String(v.size),
        'X-Upload-Content-Type': v.mimeType
      },
      body: metadata,
      redirect: 'manual'
    })
  let res = await init(await accessToken(env, deps, key, conn))
  if (res.status === 401) {
    if ((await errorReason(res)) === 'youtubeSignupRequired') throw fail(409, 'no_channel')
    res = await init(await accessToken(env, deps, key, conn, true))
  }
  if (res.status !== 200 && res.status !== 201) throw await youtubeError(res, now)
  const location = res.headers.get('location') ?? ''
  if (!acceptableSessionUri(env, location)) {
    console.error(`[posting] upload session address refused (host ${location ? new URL(location, 'https://invalid.example').hostname : 'none'})`)
    throw platformError(false)
  }
  const id = newId('u')
  await env.DB.prepare(
    "INSERT INTO uploads (id, sid, connection_id, platform, size, received, status, privacy_requested, session_uri_enc, created_at, updated_at) VALUES (?, ?, ?, 'youtube', ?, 0, 'uploading', ?, ?, ?, ?)"
  )
    .bind(id, s.sid, conn.id, v.size, v.privacy, await encrypt(key, location, ad.upload(id)), now, now)
    .run()
  console.log(`[posting] upload ${short(id)} started for ${short(s.sid)}: ${v.size} bytes, ${v.privacy}`)
  return json({ uploadId: id, status: 'uploading', size: v.size, received: 0, chunkSize: CHUNK_SIZE }, 201)
}

// ---- the session address ---------------------------------------------------------------------------------

async function uploadOf(env: Env, s: SessionRow, id: string): Promise<UploadRow> {
  const u = /^u_[0-9a-f]{32}$/.test(id) ? await env.DB.prepare('SELECT * FROM uploads WHERE id = ? AND sid = ?').bind(id, s.sid).first<UploadRow>() : null
  if (!u) throw fail(404, 'not_found')
  return u
}

interface Live {
  key: CryptoKey
  conn: ConnectionRow
  uri: string
}

async function live(env: Env, u: UploadRow): Promise<Live> {
  if (!googleConfigured(env)) throw notConfigured('google')
  const key = await encKeyOr503(env)
  const conn = await env.DB.prepare('SELECT * FROM connections WHERE id = ?').bind(u.connection_id).first<ConnectionRow>()
  if (!conn) throw fail(409, 'not_connected')
  if (!u.session_uri_enc) throw platformError(false)
  return { key, conn, uri: await decrypt(key, u.session_uri_enc, ad.upload(u.id)) }
}

/** PUT to the session address with a token; on 401, once more with a fresh token. */
async function toSession(env: Env, deps: Deps, l: Live, contentRange: string, body: Uint8Array): Promise<Response> {
  const send = (token: string) =>
    call(deps, l.uri, { method: 'PUT', headers: { Authorization: `Bearer ${token}`, 'Content-Range': contentRange }, body, redirect: 'manual' })
  const res = await send(await accessToken(env, deps, l.key, l.conn))
  if (res.status !== 401) return res
  return send(await accessToken(env, deps, l.key, l.conn, true))
}

/** Google's `Range: bytes=0-N` → N + 1; no header → nothing received yet. */
function receivedFrom(res: Response): number {
  const m = /^bytes=0-(\d+)$/.exec(res.headers.get('range') ?? '')
  return m ? Number(m[1]) + 1 : 0
}

function uploadingJson(u: UploadRow) {
  return { uploadId: u.id, status: 'uploading', size: u.size, received: u.received }
}

function doneJson(u: UploadRow, channelName: string | null) {
  const video = u.video_id
    ? {
        id: u.video_id,
        url: `https://www.youtube.com/watch?v=${u.video_id}`,
        studioUrl: `https://studio.youtube.com/video/${u.video_id}/edit`,
        privacy: u.privacy ?? u.privacy_requested,
        channelName
      }
    : null
  return { uploadId: u.id, status: 'done', size: u.size, received: u.size, video }
}

// The updates below only touch a row that is still `uploading`: a chunk answer that lands after Stop (or after
// another request finished the row) must not bring it back or change how it ended. The one exception is done:
// YouTube made the video, so the row says so even if Stop came first.

async function setReceived(env: Env, deps: Deps, u: UploadRow, received: number): Promise<void> {
  u.received = Math.min(Math.max(0, received), u.size)
  await env.DB.prepare("UPDATE uploads SET received = ?, updated_at = ? WHERE id = ? AND status = 'uploading'").bind(u.received, deps.now(), u.id).run()
}

/** false if the row had already ended some other way. */
async function finishAs(env: Env, deps: Deps, u: UploadRow, status: 'failed' | 'expired' | 'cancelled', error: string | null = null): Promise<boolean> {
  const r = await env.DB.prepare("UPDATE uploads SET status = ?, error = ?, session_uri_enc = NULL, updated_at = ? WHERE id = ? AND status = 'uploading'")
    .bind(status, error, deps.now(), u.id)
    .run()
  if ((r.meta.changes ?? 0) !== 1) return false
  u.status = status
  u.error = error
  console.log(`[posting] upload ${short(u.id)} ${status}${error ? ` (${error})` : ''}`)
  return true
}

/** YouTube answered 200/201: the video resource. */
async function finishDone(env: Env, deps: Deps, u: UploadRow, res: Response, conn: ConnectionRow): Promise<Response> {
  return json(await recordDone(env, deps, u, res, conn))
}

async function recordDone(env: Env, deps: Deps, u: UploadRow, res: Response, conn: ConnectionRow): Promise<ReturnType<typeof doneJson>> {
  const v = (await res.json().catch(() => null)) as { id?: unknown; status?: { privacyStatus?: unknown }; snippet?: { channelTitle?: unknown } } | null
  const videoId = typeof v?.id === 'string' && /^[A-Za-z0-9_-]{6,32}$/.test(v.id) ? v.id : null
  const privacy = typeof v?.status?.privacyStatus === 'string' && /^[a-z]{1,20}$/.test(v.status.privacyStatus) ? v.status.privacyStatus : null
  u.status = 'done'
  u.received = u.size
  u.video_id = videoId
  u.privacy = privacy
  await env.DB.prepare("UPDATE uploads SET status = 'done', received = size, video_id = ?, privacy = ?, error = NULL, session_uri_enc = NULL, updated_at = ? WHERE id = ?")
    .bind(videoId, privacy, deps.now(), u.id)
    .run()
  console.log(`[posting] upload ${short(u.id)} done${privacy && privacy !== u.privacy_requested ? ` (YouTube set ${privacy}, asked ${u.privacy_requested})` : ''}`)
  const channelName = conn.channel_name ?? (typeof v?.snippet?.channelTitle === 'string' ? v.snippet.channelTitle : null)
  return doneJson(u, channelName)
}

/** Ask Google how much it has: an empty PUT with `Content-Range: bytes * /size`. */
async function status(env: Env, deps: Deps, l: Live, u: UploadRow): Promise<Response> {
  return toSession(env, deps, l, `bytes */${u.size}`, new Uint8Array(0))
}

// ---- PUT /v1/uploads/:id ---------------------------------------------------------------------------------

/** The body, which must be exactly `length` bytes, read as it arrives. Reading stops as soon as more than
 * `length` arrive, so MAX_CHUNK bounds what is held in memory even when there is no Content-Length (a chunked
 * body), where arrayBuffer() would take whatever the platform lets through. */
async function readChunk(request: Request, length: number): Promise<Uint8Array> {
  const out = new Uint8Array(length)
  let at = 0
  if (request.body) {
    const reader = request.body.getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      if (at + value.byteLength > length) {
        await reader.cancel().catch(() => undefined)
        throw badRequest('content_range')
      }
      out.set(value, at)
      at += value.byteLength
    }
  }
  if (at !== length) throw badRequest('content_range')
  return out
}

export async function putChunk(request: Request, env: Env, deps: Deps, s: SessionRow, id: string): Promise<Response> {
  const u = await uploadOf(env, s, id)
  if (u.status !== 'uploading') throw fail(409, 'upload_finished', { status: u.status })
  const m = /^bytes (\d{1,12})-(\d{1,12})\/(\d{1,12})$/.exec(request.headers.get('content-range') ?? '')
  if (!m) throw badRequest('content_range')
  const [first, last, total] = [Number(m[1]), Number(m[2]), Number(m[3])]
  if (total !== u.size || last < first || last >= u.size) throw badRequest('content_range')
  if (first !== u.received) throw fail(409, 'offset_mismatch', { received: u.received })
  const length = last - first + 1
  if (length > MAX_CHUNK) throw fail(413, 'chunk_too_large', { max: MAX_CHUNK })
  if (length % GRAIN !== 0 && last !== u.size - 1) throw badRequest('content_range')
  const declared = request.headers.get('content-length')
  if (declared !== null && Number(declared) !== length) throw badRequest('content_range')
  const l = await live(env, u)
  const body = await readChunk(request, length)

  const res = await toSession(env, deps, l, `bytes ${first}-${last}/${u.size}`, body)
  if (res.status === 308) {
    await setReceived(env, deps, u, receivedFrom(res))
    return json(uploadingJson(u))
  }
  if (res.status === 200 || res.status === 201) return finishDone(env, deps, u, res, l.conn)
  if (res.status === 404) {
    await finishAs(env, deps, u, 'expired')
    throw fail(410, 'upload_expired')
  }
  if (res.status >= 500) throw platformError(true)
  if (res.status === 401) throw platformError(false)
  // Another 4xx. If Google simply has a different offset than we thought (part of an earlier chunk arrived
  // after all), say where to continue instead of failing the whole upload.
  const err = await youtubeError(res.clone(), deps.now())
  const reason = await errorReason(res)
  const check = await status(env, deps, l, u).catch(() => null)
  if (check?.status === 308) {
    const received = receivedFrom(check)
    if (received !== first) {
      await setReceived(env, deps, u, received)
      throw fail(409, 'offset_mismatch', { received })
    }
  }
  await finishAs(env, deps, u, 'failed', reason || `http_${res.status}`)
  throw err
}

// ---- GET /v1/uploads/:id ---------------------------------------------------------------------------------

export async function getUpload(env: Env, deps: Deps, s: SessionRow, id: string): Promise<Response> {
  const u = await uploadOf(env, s, id)
  if (u.status === 'done') {
    const conn = await env.DB.prepare('SELECT channel_name FROM connections WHERE id = ?').bind(u.connection_id).first<{ channel_name: string | null }>()
    return json(doneJson(u, conn?.channel_name ?? null))
  }
  if (u.status !== 'uploading') return json({ uploadId: u.id, status: u.status, size: u.size, received: u.received, ...(u.error ? { error: u.error } : {}) })
  const l = await live(env, u)
  const res = await status(env, deps, l, u)
  if (res.status === 308) {
    await setReceived(env, deps, u, receivedFrom(res))
    return json(uploadingJson(u))
  }
  if (res.status === 200 || res.status === 201) return finishDone(env, deps, u, res, l.conn)
  if (res.status === 404) {
    await finishAs(env, deps, u, 'expired')
    return json({ uploadId: u.id, status: 'expired', size: u.size, received: u.received })
  }
  throw platformError(res.status >= 500)
}

// ---- DELETE /v1/uploads/:id ------------------------------------------------------------------------------

/** Cancel. Google isn't told to stop (cancelling a YouTube upload session isn't documented); the session expires.
 * But the last chunk may already be with YouTube when Stop is pressed (a short reel is one chunk), so we ask
 * Google first: if it has the whole video, the post is done, and the answer says so (`status: 'done'` and the
 * video, as GET answers it) instead of letting the app call it stopped. If Google can't be asked, it's cancelled. */
export async function cancelUpload(env: Env, deps: Deps, s: SessionRow, id: string): Promise<Response> {
  const u = await uploadOf(env, s, id)
  if (u.status === 'uploading') {
    const finished = await (async () => {
      const l = await live(env, u)
      const res = await status(env, deps, l, u)
      return res.status === 200 || res.status === 201 ? recordDone(env, deps, u, res, l.conn) : null
    })().catch(() => null)
    if (finished) return json({ ok: true, ...finished })
    // Not changed: another request ended it first (a late chunk answer may have made it done). Answer that.
    if (!(await finishAs(env, deps, u, 'cancelled'))) Object.assign(u, await uploadOf(env, s, id))
  }
  if (u.status === 'done') {
    const conn = await env.DB.prepare('SELECT channel_name FROM connections WHERE id = ?').bind(u.connection_id).first<{ channel_name: string | null }>()
    return json({ ok: true, ...doneJson(u, conn?.channel_name ?? null) })
  }
  return json({ ok: true })
}
