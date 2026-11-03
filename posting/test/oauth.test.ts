import { describe, expect, it } from 'vitest'
import { pkceChallenge } from '../src/crypto'
import { SCOPE_READONLY, SCOPE_UPLOAD } from '../src/google'
import { CALLBACK, ORIGIN, SID, body, browse, connected, cookieOf, endSubscription, putPurchase, run, signIn, startAttempt, startUpload, world } from './fakes'

const poll = async (w: ReturnType<typeof world>, session: string, id: string) => body(await run(w, `/v1/connections/youtube/attempts/${id}`, { bearer: session }))

describe('connecting YouTube: the happy path', () => {
  it('attempt → begin → Google → callback → connected, tokens encrypted at rest', async () => {
    const w = world()
    const session = await signIn(w)
    const res = await run(w, '/v1/connections/youtube/attempts', { method: 'POST', bearer: session })
    expect(res.status).toBe(201)
    const a = await body(res)
    expect(a).toEqual({ attemptId: expect.stringMatching(/^a_[0-9a-f]{32}$/), openUrl: expect.any(String), expiresAt: w.now + 600_000, pollMs: 2000 })
    const open = new URL(a.openUrl)
    expect(open.origin + open.pathname).toBe(`${ORIGIN}/oauth/youtube/begin`)
    expect(open.searchParams.get('a')).toBe(a.attemptId)
    const t = open.searchParams.get('t')!
    expect(t).toMatch(/^[A-Za-z0-9_-]{43}$/)
    // Only the hash of the begin token is stored.
    expect(JSON.stringify(w.db.rows('oauth_attempts'))).not.toContain(t)
    expect(await poll(w, session, a.attemptId)).toEqual({ status: 'waiting' })

    // The browser opens the link.
    const begin = await run(w, a.openUrl)
    expect(begin.status).toBe(302)
    expect(begin.headers.get('referrer-policy')).toBe('no-referrer')
    const setCookie = begin.headers.get('set-cookie')!
    expect(setCookie).toMatch(/^rs_oauth=[A-Za-z0-9_-]{43}; Path=\/v1\/youtube\/callback; HttpOnly; SameSite=Lax; Max-Age=600; Secure$/)
    const google = new URL(begin.headers.get('location')!)
    expect(google.origin + google.pathname).toBe(w.google.env.GOOGLE_AUTH_URL)
    const q = google.searchParams
    expect(q.get('client_id')).toBe('fake-client-id')
    expect(q.get('redirect_uri')).toBe(`${ORIGIN}${CALLBACK}`)
    expect(q.get('response_type')).toBe('code')
    expect(q.get('scope')).toBe(`${SCOPE_UPLOAD} ${SCOPE_READONLY}`)
    expect(q.get('access_type')).toBe('offline')
    expect(q.get('prompt')).toBe('select_account consent')
    expect(q.get('code_challenge_method')).toBe('S256')
    const row = w.db.rows<{ state: string; code_verifier: string; status: string; cookie_hash: string }>('oauth_attempts')[0]
    expect(row.status).toBe('opened')
    expect(q.get('state')).toBe(row.state)
    expect(q.get('code_challenge')).toBe(await pkceChallenge(row.code_verifier))
    expect(row.code_verifier.length).toBeGreaterThanOrEqual(43)
    expect(await poll(w, session, a.attemptId)).toEqual({ status: 'opened' })

    // Google approves and sends the browser back.
    const back = await w.google.handle(new Request(google.toString()))
    expect(back.status).toBe(302)
    const callback = await run(w, back.headers.get('location')!, { cookie: cookieOf(begin) })
    expect(callback.status).toBe(200)
    expect(callback.headers.get('content-security-policy')).toBe("default-src 'none'; style-src 'unsafe-inline'")
    expect(callback.headers.get('set-cookie')).toContain('rs_oauth=; Path=/v1/youtube/callback; HttpOnly; SameSite=Lax; Max-Age=0')
    const html = await callback.text()
    expect(html).toContain('<h1>YouTube is connected</h1>')
    expect(html).toContain('Reel Studio can now post to Fake Channel, only when you click Post.')

    const polled = await poll(w, session, a.attemptId)
    expect(polled).toEqual({
      status: 'connected',
      connection: {
        platform: 'youtube',
        id: expect.stringMatching(/^c_[0-9a-f]{32}$/),
        status: 'connected',
        channelId: 'UCfakeChannel00000000001',
        channelName: 'Fake Channel',
        channelUrl: 'https://www.youtube.com/@fakechannel',
        connectedAt: w.now
      }
    })
    const me = await body(await run(w, '/v1/me', { bearer: session }))
    expect(me.connections).toEqual([polled.connection])

    // The attempt's secrets are gone; the tokens are stored encrypted, never in the clear.
    const done = w.db.rows<Record<string, unknown>>('oauth_attempts')[0]
    expect([done.state, done.code_verifier, done.cookie_hash]).toEqual([null, null, null])
    const conn = w.db.rows<{ refresh_enc: string; access_enc: string; scopes: string }>('connections')[0]
    expect(conn.refresh_enc).toMatch(/^k1\./)
    expect(conn.access_enc).toMatch(/^k1\./)
    expect(conn.scopes).toBe(`${SCOPE_UPLOAD} ${SCOPE_READONLY}`)
    const dump = JSON.stringify(w.db.rows('connections'))
    for (const token of [...w.google.state.refreshTokens.keys(), ...w.google.state.accessTokens.keys()]) expect(dump).not.toContain(token)
  })

  it('the code exchange sends the PKCE verifier and the same redirect URI (the fake checks both)', async () => {
    const w = world()
    await connected(w)
    expect(w.google.state.calls).toContain('POST /token grant_type=authorization_code')
    expect(w.google.state.refreshTokens.size).toBe(1)
  })

  it('OAUTH_PKCE=off leaves PKCE out', async () => {
    const w = world({ env: { OAUTH_PKCE: 'off' }, google: { requirePkce: false } })
    const session = await signIn(w)
    const { openUrl } = await startAttempt(w, session)
    const r = await browse(w, openUrl)
    const q = new URL(r.begin.headers.get('location')!).searchParams
    expect(q.has('code_challenge')).toBe(false)
    expect(r.callback!.status).toBe(200)
  })

  it('works with the Allow page of the fake (autoApprove off)', async () => {
    const w = world({ google: { autoApprove: false } })
    const session = await signIn(w)
    const { attemptId, openUrl } = await startAttempt(w, session)
    const begin = await run(w, openUrl)
    const pageRes = await w.google.handle(new Request(begin.headers.get('location')!))
    const html = await pageRes.text()
    const allow = /id="allow" href="([^"]+)"/.exec(html)![1].replace(/&amp;/g, '&')
    const back = await w.google.handle(new Request(allow))
    const cb = await run(w, back.headers.get('location')!, { cookie: cookieOf(begin) })
    expect(cb.status).toBe(200)
    expect((await poll(w, session, attemptId)).status).toBe('connected')
  })
})

describe('connecting YouTube: the other outcomes', () => {
  it('denied: Cancel on Google → "Nothing was connected", nothing stored', async () => {
    const w = world()
    const session = await signIn(w)
    const { attemptId, openUrl } = await startAttempt(w, session)
    w.google.state.faults.push({ on: 'authorize', reason: 'access_denied' })
    const r = await browse(w, openUrl)
    expect(r.callback!.status).toBe(200)
    expect(await r.callback!.text()).toContain('<h1>Nothing was connected</h1>')
    expect(await poll(w, session, attemptId)).toEqual({ status: 'denied' })
    expect(w.db.rows('connections')).toHaveLength(0)
  })

  it('missing_permission: upload unticked → the grant is revoked, nothing stored', async () => {
    const w = world({ google: { grantedScopes: [SCOPE_READONLY] } })
    const session = await signIn(w)
    const { attemptId, openUrl } = await startAttempt(w, session)
    const r = await browse(w, openUrl)
    expect(await r.callback!.text()).toContain('Reel Studio needs permission to upload')
    expect(await poll(w, session, attemptId)).toEqual({ status: 'missing_permission' })
    expect(w.google.state.revoked).toHaveLength(1)
    expect([...w.google.state.refreshTokens.values()].every((t) => t.revoked)).toBe(true)
    expect(w.db.rows('connections')).toHaveLength(0)
  })

  it('readonly unticked: connects anyway, without the channel name', async () => {
    const w = world({ google: { grantedScopes: [SCOPE_UPLOAD] } })
    const session = await signIn(w)
    const { attemptId, openUrl } = await startAttempt(w, session)
    const r = await browse(w, openUrl)
    expect(await r.callback!.text()).toContain('Reel Studio can now post to your channel, only when you click Post.')
    const p = await poll(w, session, attemptId)
    expect(p.status).toBe('connected')
    expect(p.connection).toMatchObject({ channelId: null, channelName: null, channelUrl: null })
    expect(w.google.state.revoked).toHaveLength(0)
  })

  it('no_channel: a Google account without a channel → revoked, nothing stored', async () => {
    const w = world({ google: { channel: null } })
    const session = await signIn(w)
    const { attemptId, openUrl } = await startAttempt(w, session)
    const r = await browse(w, openUrl)
    expect(await r.callback!.text()).toContain('This Google account has no YouTube channel')
    expect(await poll(w, session, attemptId)).toEqual({ status: 'no_channel' })
    expect(w.google.state.revoked).toHaveLength(1)
    expect(w.db.rows('connections')).toHaveLength(0)
  })

  it('failed: the code exchange fails', async () => {
    const w = world()
    const session = await signIn(w)
    const { attemptId, openUrl } = await startAttempt(w, session)
    w.google.state.faults.push({ on: 'token', status: 500, reason: 'internal_failure' })
    const r = await browse(w, openUrl)
    expect(r.callback!.status).toBe(502)
    expect(await r.callback!.text()).toContain("YouTube couldn't be connected")
    expect(await poll(w, session, attemptId)).toEqual({ status: 'failed' })
  })

  it('expired: an attempt older than 10 minutes', async () => {
    const w = world()
    const session = await signIn(w)
    const { attemptId, openUrl } = await startAttempt(w, session)
    w.now += 600_001
    expect(await poll(w, session, attemptId)).toEqual({ status: 'expired' })
    const begin = await run(w, openUrl)
    expect(begin.status).toBe(410)
    expect(await begin.text()).toContain('<h1>This link has expired</h1>')
  })

  it('expired between begin and callback', async () => {
    const w = world()
    const session = await signIn(w)
    const { openUrl } = await startAttempt(w, session)
    const begin = await run(w, openUrl)
    const back = await w.google.handle(new Request(begin.headers.get('location')!))
    w.now += 600_001
    const cb = await run(w, back.headers.get('location')!, { cookie: cookieOf(begin) })
    expect(cb.status).toBe(410)
    expect(w.db.rows('connections')).toHaveLength(0)
  })

  it('the begin link works once', async () => {
    const w = world()
    const session = await signIn(w)
    const { openUrl } = await startAttempt(w, session)
    expect((await run(w, openUrl)).status).toBe(302)
    expect((await run(w, openUrl)).status).toBe(410)
    // A wrong token never works.
    const other = await startAttempt(w, session)
    const u = new URL(other.openUrl)
    u.searchParams.set('t', 'A'.repeat(43))
    expect((await run(w, u.toString())).status).toBe(410)
  })

  it('a callback without the cookie (another browser) or with the wrong one is refused, and the attempt stays open', async () => {
    const w = world()
    const session = await signIn(w)
    const { attemptId, openUrl } = await startAttempt(w, session)
    const begin = await run(w, openUrl)
    const back = (await w.google.handle(new Request(begin.headers.get('location')!))).headers.get('location')!
    expect((await run(w, back)).status).toBe(410)
    expect((await run(w, back, { cookie: 'rs_oauth=' + 'A'.repeat(43) })).status).toBe(410)
    expect(await poll(w, session, attemptId)).toEqual({ status: 'opened' })
    // The right browser still finishes.
    const ok = await run(w, back, { cookie: cookieOf(begin) })
    expect(ok.status).toBe(200)
    // And the same callback can't be replayed.
    expect((await run(w, back, { cookie: cookieOf(begin) })).status).toBe(410)
    expect(w.db.rows('connections')).toHaveLength(1)
  })

  it('an unknown state is refused', async () => {
    const w = world()
    expect((await run(w, `${CALLBACK}?state=nope&code=x`)).status).toBe(410)
    expect((await run(w, CALLBACK)).status).toBe(410)
  })

  it('a newer attempt cancels the older one; cancelling makes the link expire', async () => {
    const w = world()
    const session = await signIn(w)
    const first = await startAttempt(w, session)
    const second = await startAttempt(w, session)
    expect(await poll(w, session, first.attemptId)).toEqual({ status: 'cancelled' })
    expect((await run(w, first.openUrl)).status).toBe(410)
    const begin = await run(w, second.openUrl)
    const back = (await w.google.handle(new Request(begin.headers.get('location')!))).headers.get('location')!
    const del = await run(w, `/v1/connections/youtube/attempts/${second.attemptId}`, { method: 'DELETE', bearer: session })
    expect(await body(del)).toEqual({ ok: true })
    expect(await poll(w, session, second.attemptId)).toEqual({ status: 'cancelled' })
    expect((await run(w, back, { cookie: cookieOf(begin) })).status).toBe(410)
  })

  it('a session signed out mid-flow: the callback says expired and stores nothing', async () => {
    const w = world()
    const session = await signIn(w)
    const { openUrl } = await startAttempt(w, session)
    const begin = await run(w, openUrl)
    const back = (await w.google.handle(new Request(begin.headers.get('location')!))).headers.get('location')!
    await run(w, '/v1/sessions/current', { method: 'DELETE', bearer: session })
    expect((await run(w, back, { cookie: cookieOf(begin) })).status).toBe(410)
    expect(w.db.rows('connections')).toHaveLength(0)
  })

  it('a purchase that ended mid-flow: "Posting needs an active subscription"', async () => {
    const w = world()
    const session = await signIn(w)
    const { openUrl } = await startAttempt(w, session)
    const begin = await run(w, openUrl)
    const back = (await w.google.handle(new Request(begin.headers.get('location')!))).headers.get('location')!
    endSubscription(w)
    const cb = await run(w, back, { cookie: cookieOf(begin) })
    expect(cb.status).toBe(403)
    const html = await cb.text()
    expect(html).toContain('Posting needs an active subscription')
    expect(html).toContain('href="https://getreelstudio.com/#pricing"')
    expect(w.db.rows('connections')).toHaveLength(0)
  })

  it("another purchase's attempt is 404", async () => {
    const w = world()
    const mine = await signIn(w)
    const { attemptId } = await startAttempt(w, mine)
    putPurchase(w, { sid: 'cs_test_other_purchase_0000000000000000000000' })
    w.db.run("UPDATE oauth_attempts SET sid = 'cs_test_other_purchase_0000000000000000000000'")
    expect((await run(w, `/v1/connections/youtube/attempts/${attemptId}`, { bearer: mine })).status).toBe(404)
    expect((await run(w, `/v1/connections/youtube/attempts/${attemptId}`, { method: 'DELETE', bearer: mine })).status).toBe(404)
    expect((await run(w, '/v1/connections/youtube/attempts/a_nothex', { bearer: mine })).status).toBe(404)
  })

  it('limits attempts to 20 an hour per purchase', async () => {
    const w = world()
    const session = await signIn(w)
    for (let i = 0; i < 20; i++) await startAttempt(w, session)
    const res = await run(w, '/v1/connections/youtube/attempts', { method: 'POST', bearer: session })
    expect(res.status).toBe(429)
    expect(res.headers.get('retry-after')).toBeTruthy()
  })
})

describe('replacing and disconnecting', () => {
  it('connecting another channel revokes the old grant and forgets it with its post history', async () => {
    const w = world()
    const { session } = await connected(w)
    const oldRefresh = [...w.google.state.refreshTokens.keys()][0]
    expect((await startUpload(w, session, 1000)).status).toBe(201)
    w.google.state.channel = { id: 'UCsecondChannel000000002', title: 'Second', customUrl: '@second' }
    const { openUrl } = await startAttempt(w, session)
    const r = await browse(w, openUrl)
    expect(r.callback!.status).toBe(200)
    expect(w.google.state.revoked).toEqual([oldRefresh])
    expect(w.google.state.refreshTokens.get(oldRefresh)!.revoked).toBe(true)
    const conns = w.db.rows<{ channel_name: string }>('connections')
    expect(conns.map((c) => c.channel_name)).toEqual(['Second'])
    expect(w.db.rows('uploads')).toHaveLength(0)
  })

  it('connecting the same channel again does not revoke (it is the same Google grant)', async () => {
    const w = world()
    const { session } = await connected(w)
    const { openUrl } = await startAttempt(w, session)
    expect((await browse(w, openUrl)).callback!.status).toBe(200)
    expect(w.google.state.revoked).toEqual([])
    expect(w.db.rows('connections')).toHaveLength(1)
  })

  it('DELETE /v1/connections/youtube revokes at Google and deletes the tokens and the post history', async () => {
    const w = world()
    const { session } = await connected(w)
    expect((await startUpload(w, session, 1000)).status).toBe(201)
    const refresh = [...w.google.state.refreshTokens.keys()][0]
    const res = await run(w, '/v1/connections/youtube', { method: 'DELETE', bearer: session })
    expect(await body(res)).toEqual({ ok: true, revoked: true })
    expect(w.google.state.revoked).toEqual([refresh])
    expect(w.google.state.refreshTokens.get(refresh)!.revoked).toBe(true)
    expect(w.db.rows('connections')).toHaveLength(0)
    expect(w.db.rows('uploads')).toHaveLength(0)
    expect((await body(await run(w, '/v1/me', { bearer: session }))).connections).toEqual([])
    // Nothing left: still ok.
    expect(await body(await run(w, '/v1/connections/youtube', { method: 'DELETE', bearer: session }))).toEqual({ ok: true, revoked: false })
  })

  it('a token Google already forgot (400) still disconnects, revoked false', async () => {
    const w = world()
    const { session } = await connected(w)
    w.google.revokeAll()
    expect(await body(await run(w, '/v1/connections/youtube', { method: 'DELETE', bearer: session }))).toEqual({ ok: true, revoked: false })
    expect(w.db.rows('connections')).toHaveLength(0)
  })

  it('disconnect works after the subscription ended', async () => {
    const w = world()
    const { session } = await connected(w)
    endSubscription(w)
    expect(await body(await run(w, '/v1/connections/youtube', { method: 'DELETE', bearer: session }))).toEqual({ ok: true, revoked: true })
  })
})

describe('not configured', () => {
  it('without the Google client: health says so, connect and upload answer 503 google', async () => {
    const w = world({ env: { GOOGLE_CLIENT_ID: undefined, GOOGLE_CLIENT_SECRET: undefined } })
    expect(await body(await run(w, '/v1/health'))).toEqual({ ok: true, youtube: false })
    const session = await signIn(w)
    const res = await run(w, '/v1/connections/youtube/attempts', { method: 'POST', bearer: session })
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual({ error: 'not_configured', what: 'google' })
    expect(await body(await startUpload(w, session, 1000))).toEqual({ error: 'not_configured', what: 'google' })
    // Signing in and /me still work.
    expect((await run(w, '/v1/me', { bearer: session })).status).toBe(200)
  })

  it('without ENC_KEY: connect answers 503 enc_key', async () => {
    const w = world({ env: { ENC_KEY: 'too-short' } })
    const session = await signIn(w)
    expect(await body(await run(w, '/v1/connections/youtube/attempts', { method: 'POST', bearer: session }))).toEqual({ error: 'not_configured', what: 'enc_key' })
  })
})

it('uses SID from the purchase, not from anything the browser sends', async () => {
  const w = world()
  await connected(w)
  expect(w.db.rows<{ sid: string }>('connections')[0].sid).toBe(SID)
})
