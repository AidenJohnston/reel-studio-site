// The daily cron (17 4 * * * UTC). Keeps what we hold no longer than it is needed:
//
//   1. Purchases that are gone (the downloads Worker's 90-day retention deleted the record, or support ran
//      `forget`): revoke their Google tokens, then delete their connections, uploads, attempts and sessions.
//      A purchase that exists but isn't entitled keeps its rows; every use is refused until it is entitled again
//      or deleted.
//   2. Connections whose channel was last checked over 25 days ago: refresh and read the channel again. A grant
//      removed in Google's settings (or the 7-day Testing expiry) answers invalid_grant: the connection needs
//      connecting again and what came from that grant goes, so nothing from a revoked grant outlives 30 days.
//   3. Old rows: attempts over a day old, unfinished uploads over two days old (expired), sessions unused for
//      180 days, rate-limit windows that have ended.
//   4. One log line.
import { getPurchase } from '../../worker/src/records'
import type { Deps, Env } from './app'
import { importEncKey } from './crypto'
import { readOnly, type ConnectionRow } from './db'
import { accessToken, googleConfigured, myChannel } from './google'
import { ApiError } from './http'
import { revokeStored } from './oauth'

const DAY = 86400_000
export const CHANNEL_CHECK_DAYS = 25
export const SESSION_IDLE_DAYS = 180
export const MAX_CHECKS = 200

export interface RetentionReport {
  gonePurchases: number
  reconnect: number
  refreshed: number
  expiredUploads: number
  oldSessions: number
}

export async function retention(env: Env, deps: Deps): Promise<RetentionReport> {
  const now = deps.now()
  const db = env.DB
  const report: RetentionReport = { gonePurchases: 0, reconnect: 0, refreshed: 0, expiredUploads: 0, oldSessions: 0 }
  const key = await importEncKey(env.ENC_KEY)
  if (!key) console.error('[posting] retention: ENC_KEY is not set, so tokens are neither revoked nor refreshed')

  // 1. Purchases that are gone. (Without ENC_KEY their tokens can't be revoked, so they wait for it.)
  if (key) {
    const kv = readOnly(env.PURCHASES)
    const { results } = await db.prepare('SELECT sid FROM sessions UNION SELECT sid FROM connections').all<{ sid: string }>()
    for (const { sid } of results) {
      if (await getPurchase(kv, sid)) continue
      const conns = await db.prepare('SELECT id, refresh_enc FROM connections WHERE sid = ?').bind(sid).all<Pick<ConnectionRow, 'id' | 'refresh_enc'>>()
      for (const c of conns.results) await revokeStored(env, deps, key, c)
      await db.batch(['uploads', 'connections', 'oauth_attempts', 'sessions'].map((t) => db.prepare(`DELETE FROM ${t} WHERE sid = ?`).bind(sid)))
      report.gonePurchases++
    }
  }

  // 2. Re-check channels (needs the client id and secret to refresh).
  if (key && googleConfigured(env)) {
    const { results } = await db
      .prepare("SELECT * FROM connections WHERE status = 'connected' AND refresh_enc IS NOT NULL AND (channel_checked_at IS NULL OR channel_checked_at < ?) ORDER BY channel_checked_at LIMIT ?")
      .bind(now - CHANNEL_CHECK_DAYS * DAY, MAX_CHECKS)
      .all<ConnectionRow>()
    for (const c of results) {
      let token: string
      try {
        token = await accessToken(env, deps, key, c, true)
      } catch (e) {
        if (e instanceof ApiError && e.body.error === 'reconnect_needed') report.reconnect++
        continue
      }
      const ch = await myChannel(env, deps, token)
      if (ch.kind === 'error') continue
      if (ch.kind === 'channel') {
        await db.prepare('UPDATE connections SET channel_id = ?, channel_name = ?, channel_handle = ?, channel_checked_at = ?, updated_at = ? WHERE id = ?')
          .bind(ch.channel.id, ch.channel.title, ch.channel.handle, now, now, c.id)
          .run()
      } else {
        // No channel any more, or youtube.readonly not granted: keep connected, forget the channel fields.
        await db.prepare('UPDATE connections SET channel_id = NULL, channel_name = NULL, channel_handle = NULL, channel_checked_at = ?, updated_at = ? WHERE id = ?')
          .bind(now, now, c.id)
          .run()
      }
      report.refreshed++
    }
  }

  // 3. Old rows.
  const [, expired, , sessions] = await db.batch([
    db.prepare('DELETE FROM oauth_attempts WHERE created_at < ?').bind(now - DAY),
    db.prepare("UPDATE uploads SET status = 'expired', session_uri_enc = NULL, updated_at = ? WHERE status = 'uploading' AND created_at < ?").bind(now, now - 2 * DAY),
    db.prepare('DELETE FROM rate_limits WHERE expires_at < ?').bind(now),
    db.prepare('DELETE FROM sessions WHERE last_used_at < ?').bind(now - SESSION_IDLE_DAYS * DAY)
  ])
  report.expiredUploads = expired.meta.changes ?? 0
  report.oldSessions = sessions.meta.changes ?? 0

  console.log(
    `[posting] retention: gone purchases ${report.gonePurchases}, reconnect ${report.reconnect}, refreshed ${report.refreshed}, expired uploads ${report.expiredUploads}, old sessions ${report.oldSessions}`
  )
  return report
}
