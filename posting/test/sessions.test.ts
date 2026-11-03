import { describe, expect, it } from 'vitest'
import { readOnly } from '../src/db'
import { sha256hex } from '../src/crypto'
import { MAX_SESSIONS } from '../src/sessions'
import { SID, body, connected, endSubscription, purchaseKey, putPurchase, run, signIn, world } from './fakes'

const trade = async (w: ReturnType<typeof world>, key: string | null, json: unknown = { device: 'Windows' }, ip?: string) =>
  run(w, '/v1/sessions', { method: 'POST', ...(key ? { bearer: key } : {}), json, ip })

describe('POST /v1/sessions: the purchase key for a session', () => {
  it('trades a valid key once and stores only the hash of the session', async () => {
    const w = world()
    const res = await trade(w, await purchaseKey())
    expect(res.status).toBe(201)
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(res.headers.get('x-content-type-options')).toBe('nosniff')
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    const b = await body(res)
    expect(b).toEqual({ session: expect.stringMatching(/^ps1_[A-Za-z0-9_-]{43}$/), sessionId: expect.stringMatching(/^s_[0-9a-f]{32}$/), plan: 'monthly', device: 'Windows' })
    const rows = w.db.rows<{ token_hash: string; sid: string; device: string }>('sessions')
    expect(rows).toHaveLength(1)
    expect(rows[0].sid).toBe(SID)
    expect(rows[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
    expect(JSON.stringify(rows)).not.toContain(b.session)
  })

  it('takes an expired key: the purchase is checked, not the key age', async () => {
    const w = world()
    const res = await trade(w, await purchaseKey({ e: 1 }))
    expect(res.status).toBe(201)
  })

  it('refuses a missing key (no_key) and a forged or edited one (bad_key)', async () => {
    const w = world()
    expect(await body(await trade(w, null))).toEqual({ error: 'no_key' })
    const forged = await purchaseKey({}, 'some-other-secret-that-is-long-enough-0000')
    const r1 = await trade(w, forged)
    expect(r1.status).toBe(401)
    expect(await body(r1)).toEqual({ error: 'bad_key' })
    const real = await purchaseKey()
    const [v, , sig] = real.split('.')
    const edited = `${v}.${btoa(JSON.stringify({ s: 'cs_test_someone_else', p: 'once', e: 9e9 })).replace(/=+$/, '')}.${sig}`
    expect((await trade(w, edited)).status).toBe(401)
    expect((await trade(w, 'ps1_not-a-key')).status).toBe(401)
    expect(w.db.rows('sessions')).toHaveLength(0)
  })

  it('refuses a purchase that is not entitled, with the reason', async () => {
    const w = world()
    endSubscription(w)
    const res = await trade(w, await purchaseKey())
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: 'not_entitled', reason: 'subscription ended' })

    const once = world({ purchase: { plan: 'once', subscription: null, paymentIntent: 'pi_1AbCdEfGhIjKlMnOp' } })
    once.kv.store.set('pay:pi_1AbCdEfGhIjKlMnOp', JSON.stringify({ refunded: true, at: 1 }))
    expect(await body(await trade(once, await purchaseKey({ p: 'once' })))).toEqual({ error: 'not_entitled', reason: 'refunded' })
  })

  it('refuses a key whose purchase record is gone', async () => {
    const w = world({ purchase: null })
    const res = await trade(w, await purchaseKey())
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: 'not_entitled', reason: 'unknown purchase' })
  })

  it('takes only Windows, Mac or Linux as the device', async () => {
    const w = world()
    for (const device of ['DESKTOP-ABC123', '', 42, null]) {
      const res = await trade(w, await purchaseKey(), { device })
      expect(res.status).toBe(400)
      expect(await body(res)).toEqual({ error: 'bad_request', field: 'device' })
    }
    expect((await trade(w, await purchaseKey(), 'not json')).status).toBe(400)
  })

  it(`keeps at most ${MAX_SESSIONS} sessions per purchase, dropping the one used longest ago`, async () => {
    const w = world()
    const sessions: string[] = []
    for (let i = 0; i < MAX_SESSIONS; i++) {
      sessions.push(await signIn(w, 'Mac'))
      w.now += 1000
    }
    // Use the first one again two hours later, so the second is now the one used longest ago.
    w.now += 2 * 3600_000
    expect((await run(w, '/v1/me', { bearer: sessions[0] })).status).toBe(200)
    const eleventh = await signIn(w, 'Linux')
    expect(w.db.rows('sessions')).toHaveLength(MAX_SESSIONS)
    expect((await run(w, '/v1/me', { bearer: sessions[1] })).status).toBe(401)
    expect((await run(w, '/v1/me', { bearer: sessions[0] })).status).toBe(200)
    expect((await run(w, '/v1/me', { bearer: eleventh })).status).toBe(200)
  })

  it('limits trades to 20 an hour per IP', async () => {
    const w = world()
    const key = await purchaseKey()
    for (let i = 0; i < 20; i++) expect((await trade(w, key, { device: 'Windows' }, '198.51.100.1')).status).toBe(201)
    const res = await trade(w, key, { device: 'Windows' }, '198.51.100.1')
    expect(res.status).toBe(429)
    expect(await body(res)).toEqual({ error: 'rate_limited' })
    expect(Number(res.headers.get('retry-after'))).toBeGreaterThan(0)
    expect((await trade(w, key, { device: 'Windows' }, '198.51.100.2')).status).toBe(201)
    // The IP itself is never stored, nor a plain hash of it (which trying every IPv4 address would undo).
    const dump = JSON.stringify(w.db.rows('rate_limits'))
    expect(dump).not.toContain('198.51.100')
    expect(dump).not.toContain((await sha256hex('ip:198.51.100.1')).slice(0, 32))
    w.now += 3600_000
    expect((await trade(w, key, { device: 'Windows' }, '198.51.100.1')).status).toBe(201)
    // The ended hour's rows went with that try; only the new window's row is left.
    expect(w.db.rows<{ key: string; n: number }>('rate_limits')).toEqual([expect.objectContaining({ n: 1 })])
  })

  it('answers 503 not_configured without TOKEN_SECRET', async () => {
    const w = world({ env: { TOKEN_SECRET: undefined } })
    const res = await trade(w, await purchaseKey())
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual({ error: 'not_configured', what: 'token_secret' })
  })
})

describe('using a session', () => {
  it('GET /v1/me: plan, this session, other computers, no connections yet', async () => {
    const w = world()
    const a = await signIn(w, 'Windows')
    await signIn(w, 'Mac')
    const res = await run(w, '/v1/me', { bearer: a })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({
      plan: 'monthly',
      session: { id: expect.stringMatching(/^s_/), device: 'Windows', createdAt: w.now },
      otherSessions: 1,
      connections: []
    })
  })

  it('refuses a missing, malformed or unknown session', async () => {
    const w = world()
    expect(await body(await run(w, '/v1/me'))).toEqual({ error: 'no_session' })
    const unknown = await run(w, '/v1/me', { bearer: 'ps1_' + 'A'.repeat(43) })
    expect(unknown.status).toBe(401)
    expect(await body(unknown)).toEqual({ error: 'bad_session' })
    // The purchase key itself is not a session.
    expect(await body(await run(w, '/v1/me', { bearer: await purchaseKey() }))).toEqual({ error: 'bad_session' })
  })

  it('checks the purchase again on every use: a subscription that ends stops the session at once', async () => {
    const w = world()
    const s = await signIn(w)
    expect((await run(w, '/v1/me', { bearer: s })).status).toBe(200)
    endSubscription(w)
    const res = await run(w, '/v1/me', { bearer: s })
    expect(res.status).toBe(403)
    expect(await body(res)).toEqual({ error: 'not_entitled', reason: 'subscription ended' })
    expect((await run(w, '/v1/connections/youtube/attempts', { method: 'POST', bearer: s })).status).toBe(403)
    expect((await run(w, '/v1/uploads', { method: 'POST', bearer: s, json: {} })).status).toBe(403)
  })

  it('a session whose purchase record was deleted answers unknown purchase', async () => {
    const w = world()
    const s = await signIn(w)
    w.kv.store.delete(`sess:${SID}`)
    expect(await body(await run(w, '/v1/me', { bearer: s }))).toEqual({ error: 'not_entitled', reason: 'unknown purchase' })
  })

  it('caches the entitlement answer for 60 seconds per isolate when given a cache', async () => {
    const w = world({ cache: true })
    const s = await signIn(w)
    expect((await run(w, '/v1/me', { bearer: s })).status).toBe(200)
    const reads = w.kv.reads
    endSubscription(w)
    w.now += 30_000
    expect((await run(w, '/v1/me', { bearer: s })).status).toBe(200)
    expect(w.kv.reads).toBe(reads)
    w.now += 31_000
    expect((await run(w, '/v1/me', { bearer: s })).status).toBe(403)
    // The refusal is cached too, and lifts when it expires.
    putPurchase(w)
    w.kv.store.delete('sub:sub_1AbCdEfGhIjKlMnOp')
    expect((await run(w, '/v1/me', { bearer: s })).status).toBe(403)
    w.now += 61_000
    expect((await run(w, '/v1/me', { bearer: s })).status).toBe(200)
  })

  it('updates last_used_at at most once an hour', async () => {
    const w = world()
    const s = await signIn(w)
    const t0 = w.now
    w.now += 10 * 60_000
    await run(w, '/v1/me', { bearer: s })
    expect(w.db.rows<{ last_used_at: number }>('sessions')[0].last_used_at).toBe(t0)
    w.now += 60 * 60_000
    await run(w, '/v1/me', { bearer: s })
    expect(w.db.rows<{ last_used_at: number }>('sessions')[0].last_used_at).toBe(w.now)
  })
})

describe('signing out', () => {
  it('DELETE /v1/sessions/current signs out this computer only', async () => {
    const w = world()
    const a = await signIn(w)
    const b = await signIn(w, 'Mac')
    const res = await run(w, '/v1/sessions/current', { method: 'DELETE', bearer: a })
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true })
    expect((await run(w, '/v1/me', { bearer: a })).status).toBe(401)
    expect((await run(w, '/v1/me', { bearer: b })).status).toBe(200)
  })

  it('DELETE /v1/sessions signs out every computer and keeps the YouTube connection', async () => {
    const w = world()
    const { session } = await connected(w)
    const other = await signIn(w, 'Mac')
    const res = await run(w, '/v1/sessions', { method: 'DELETE', bearer: other })
    expect(await body(res)).toEqual({ ok: true, signedOut: 2 })
    expect((await run(w, '/v1/me', { bearer: session })).status).toBe(401)
    expect((await run(w, '/v1/me', { bearer: other })).status).toBe(401)
    expect(w.db.rows('connections')).toHaveLength(1)
    // A new sign-in finds the connection still there.
    const again = await signIn(w)
    const me = await body(await run(w, '/v1/me', { bearer: again }))
    expect(me.connections).toHaveLength(1)
    expect(me.connections[0]).toMatchObject({ platform: 'youtube', status: 'connected', channelName: 'Fake Channel' })
  })

  it('works after the subscription ended, so nobody is stuck signed in', async () => {
    const w = world()
    const s = await signIn(w)
    endSubscription(w)
    expect((await run(w, '/v1/sessions/current', { method: 'DELETE', bearer: s })).status).toBe(200)
  })
})

describe('PURCHASES is read only', () => {
  it('the wrapper refuses writes and deletes', async () => {
    const store = new Map([['sess:x', '{}']])
    const kv = { get: async (k: string) => store.get(k) ?? null, put: async () => store.set('written', '1'), delete: async () => store.clear() } as unknown as KVNamespace
    const ro = readOnly(kv)
    expect(await ro.get('sess:x', 'text')).toBe('{}')
    await expect(ro.put('sess:x', '{}')).rejects.toThrow(/never writes/)
    await expect(ro.delete('sess:x')).rejects.toThrow(/never deletes/)
    expect(store.has('written')).toBe(false)
    expect(store.size).toBe(1)
  })
})
