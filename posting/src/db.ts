// The D1 rows (migrations/0001_init.sql), the few queries more than one module needs, our own rate limits, and
// the read-only view of the downloads Worker's purchase records.
import type { RecordStore } from '../../worker/src/records'

export interface SessionRow {
  id: string
  token_hash: string
  sid: string
  plan: 'once' | 'monthly'
  device: string
  created_at: number
  last_used_at: number
}

export type AttemptStatus = 'waiting' | 'opened' | 'connected' | 'denied' | 'missing_permission' | 'no_channel' | 'failed' | 'cancelled'

export interface AttemptRow {
  id: string
  sid: string
  session_id: string
  platform: string
  begin_hash: string
  state: string | null
  code_verifier: string | null
  cookie_hash: string | null
  status: AttemptStatus
  connection_id: string | null
  created_at: number
  expires_at: number
}

export interface ConnectionRow {
  id: string
  sid: string
  platform: string
  status: 'connected' | 'reconnect'
  scopes: string
  channel_id: string | null
  channel_name: string | null
  channel_handle: string | null
  channel_checked_at: number | null
  refresh_enc: string | null
  access_enc: string | null
  access_expires_at: number | null
  created_at: number
  updated_at: number
}

export type UploadStatus = 'uploading' | 'done' | 'failed' | 'cancelled' | 'expired'

export interface UploadRow {
  id: string
  sid: string
  connection_id: string
  platform: string
  size: number
  received: number
  status: UploadStatus
  privacy_requested: string
  privacy: string | null
  video_id: string | null
  error: string | null
  session_uri_enc: string | null
  created_at: number
  updated_at: number
}

/** PURCHASES belongs to the downloads Worker. Cloudflare has no read-only binding, so this one is read-only by construction. */
export const readOnly = (kv: KVNamespace): RecordStore => ({
  get: (k, t) => kv.get(k, t),
  put: async () => {
    throw new Error('posting never writes purchase records')
  },
  delete: async () => {
    throw new Error('posting never deletes purchase records')
  }
})

export async function connectionFor(db: D1Database, sid: string, platform = 'youtube'): Promise<ConnectionRow | null> {
  return db.prepare('SELECT * FROM connections WHERE sid = ? AND platform = ?').bind(sid, platform).first<ConnectionRow>()
}

/** A YouTube channel's public address: its handle if we know one, else its id. */
export function channelUrl(c: Pick<ConnectionRow, 'channel_id' | 'channel_handle'>): string | null {
  if (c.channel_handle && /^@[^\s/?#]{1,100}$/.test(c.channel_handle)) return `https://www.youtube.com/${encodeURI(c.channel_handle)}`
  if (c.channel_id && /^[A-Za-z0-9_-]{6,64}$/.test(c.channel_id)) return `https://www.youtube.com/channel/${c.channel_id}`
  return null
}

/** A connection as /v1/me and the attempt poll show it. Never a token. */
export function connectionJson(c: ConnectionRow) {
  return {
    platform: c.platform,
    id: c.id,
    status: c.status,
    channelId: c.channel_id,
    channelName: c.channel_name,
    channelUrl: channelUrl(c),
    connectedAt: c.created_at
  }
}

// ---- rate limits ----------------------------------------------------------------------------------------

export interface Limit {
  bucket: string
  n: number
  windowSec: number
}

export const SESSION_LIMIT: Limit = { bucket: 'session', n: 20, windowSec: 3600 }
export const ATTEMPT_LIMIT: Limit = { bucket: 'attempt', n: 20, windowSec: 3600 }
export const UPLOAD_LIMIT: Limit = { bucket: 'upload', n: 30, windowSec: 86400 }

/** Fixed windows in D1. Counts this try and answers null if it is allowed, or the seconds until the window ends. */
export async function limited(db: D1Database, limit: Limit, who: string, nowMs: number): Promise<number | null> {
  const windowMs = limit.windowSec * 1000
  const window = Math.floor(nowMs / windowMs)
  const ends = (window + 1) * windowMs
  const row = await db
    .prepare('INSERT INTO rate_limits (key, n, expires_at) VALUES (?, 1, ?) ON CONFLICT (key) DO UPDATE SET n = n + 1 RETURNING n')
    .bind(`${limit.bucket}:${window}:${who}`, ends)
    .first<{ n: number }>()
  if ((row?.n ?? 0) <= limit.n) return null
  return Math.max(1, Math.ceil((ends - nowMs) / 1000))
}
