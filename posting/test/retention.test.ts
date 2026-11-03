import { describe, expect, it } from 'vitest'
import { retention } from '../src/retention'
import { SID, body, connected, endSubscription, run, signIn, startAttempt, startUpload, world } from './fakes'

const DAY = 86400_000

describe('the daily retention cron', () => {
  it('a purchase whose record is gone: revokes its Google tokens and deletes all its rows', async () => {
    const w = world()
    const { session } = await connected(w)
    await signIn(w, 'Mac')
    await startUpload(w, session, 1000)
    await startAttempt(w, session)
    const refresh = [...w.google.state.refreshTokens.keys()][0]
    w.kv.store.delete(`sess:${SID}`)

    const r = await retention(w.env, w.deps())
    expect(r.gonePurchases).toBe(1)
    expect(w.google.state.revoked).toEqual([refresh])
    expect(w.google.state.refreshTokens.get(refresh)!.revoked).toBe(true)
    for (const t of ['sessions', 'connections', 'uploads', 'oauth_attempts']) expect(w.db.rows(t)).toHaveLength(0)
  })

  it('a purchase that exists but is not entitled keeps its rows', async () => {
    const w = world()
    await connected(w)
    endSubscription(w)
    const r = await retention(w.env, w.deps())
    expect(r.gonePurchases).toBe(0)
    expect(w.db.rows('connections')).toHaveLength(1)
    expect(w.db.rows('sessions')).toHaveLength(1)
    expect(w.google.state.revoked).toEqual([])
  })

  it('a grant removed in Google (invalid_grant) → reconnect, tokens and channel fields cleared', async () => {
    const w = world()
    const { session } = await connected(w)
    w.now += 26 * DAY
    w.google.revokeAll()
    // Keep the session fresh so it is not the thing being cleaned up.
    w.db.run('UPDATE sessions SET last_used_at = ?', w.now)
    const r = await retention(w.env, w.deps())
    expect(r.reconnect).toBe(1)
    expect(w.db.rows<Record<string, unknown>>('connections')[0]).toMatchObject({
      status: 'reconnect',
      refresh_enc: null,
      access_enc: null,
      channel_id: null,
      channel_name: null,
      channel_handle: null
    })
    expect((await body(await run(w, '/v1/me', { bearer: session }))).connections[0].status).toBe('reconnect')
  })

  it('re-reads the channel of a connection last checked over 25 days ago, and leaves fresher ones alone', async () => {
    const w = world()
    await connected(w)
    w.now += 10 * DAY
    expect((await retention(w.env, w.deps())).refreshed).toBe(0)
    w.now += 16 * DAY
    w.google.state.channel = { id: 'UCfakeChannel00000000001', title: 'Renamed', customUrl: '@renamed' }
    const r = await retention(w.env, w.deps())
    expect(r.refreshed).toBe(1)
    expect(w.db.rows<Record<string, unknown>>('connections')[0]).toMatchObject({ status: 'connected', channel_name: 'Renamed', channel_handle: '@renamed', channel_checked_at: w.now })
  })

  it('a channel it can no longer read (403) clears the channel fields and stays connected', async () => {
    const w = world()
    await connected(w)
    w.now += 26 * DAY
    w.google.state.faults.push({ on: 'channels', status: 403, reason: 'insufficientPermissions' })
    await retention(w.env, w.deps())
    expect(w.db.rows<Record<string, unknown>>('connections')[0]).toMatchObject({ status: 'connected', channel_id: null, channel_name: null })
  })

  it('deletes old attempts, expires unfinished uploads over 2 days old, drops sessions unused for 180 days and ended rate-limit windows', async () => {
    const w = world()
    const { session } = await connected(w)
    const res = await startUpload(w, session, 1000)
    const { uploadId } = await body(res)
    w.now += 2 * DAY + 1
    w.db.run('UPDATE sessions SET last_used_at = ?', w.now)
    const r = await retention(w.env, w.deps())
    expect(r.expiredUploads).toBe(1)
    expect(w.db.rows('oauth_attempts')).toHaveLength(0)
    expect(w.db.rows('rate_limits')).toHaveLength(0)
    expect(w.db.rows<Record<string, unknown>>('uploads', 'id = ?', uploadId)[0]).toMatchObject({ status: 'expired', session_uri_enc: null })
    expect(r.oldSessions).toBe(0)

    w.now += 181 * DAY
    expect((await retention(w.env, w.deps())).oldSessions).toBe(1)
    expect(w.db.rows('sessions')).toHaveLength(0)
    // The connection belongs to the purchase, which still exists.
    expect(w.db.rows('connections')).toHaveLength(1)
  })

  it('without ENC_KEY it neither revokes nor deletes a gone purchase (its tokens wait for the key)', async () => {
    const w = world()
    await connected(w)
    w.kv.store.delete(`sess:${SID}`)
    w.env.ENC_KEY = undefined
    const r = await retention(w.env, w.deps())
    expect(r.gonePurchases).toBe(0)
    expect(w.db.rows('connections')).toHaveLength(1)
  })

  it('never writes to PURCHASES (the fake KV throws on put and delete)', async () => {
    const w = world()
    await connected(w)
    w.kv.store.delete(`sess:${SID}`)
    await expect(retention(w.env, w.deps())).resolves.toBeTruthy()
  })
})
