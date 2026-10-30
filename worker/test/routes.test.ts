import { describe, expect, it } from 'vitest'
import { CLAIM_LIMIT, LINK_LIMIT, handle } from '../src/app'
import { mintToken } from '../src/token'
import { MANIFEST, SECRET, SID, T0, deps, paidSession, req, signed, world } from './fakes'

const run = (w: ReturnType<typeof world>, r: Request) => handle(r, w.env, w.ctx, deps(w))

describe('GET /latest.json', () => {
  it('answers version, page and file names, cacheable, open to any origin, no R2 keys', async () => {
    const w = world()
    const res = await run(w, req('/latest.json'))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('cache-control')).toBe('public, max-age=300')
    const body = await res.json()
    expect(body).toEqual({
      version: '0.1.2',
      url: 'https://getreelstudio.com/update.html',
      files: { win: { name: 'Reel-Studio-Setup-0.1.2-x64.exe', size: 5, sha256: 'a'.repeat(64) }, mac: { name: 'Reel-Studio-0.1.2-arm64.dmg', size: 3, sha256: 'b'.repeat(64) } }
    })
  })
  it('503 with no manifest (nothing is downloadable until a release is published)', async () => {
    const w = world({ manifest: null })
    expect((await run(w, req('/latest.json'))).status).toBe(503)
  })
})

describe('GET /api/claim?session_id', () => {
  it('a paid session: records it (email hashed), mints a token, answers links for the current version', async () => {
    const w = world()
    const res = await run(w, req(`/api/claim?session_id=${SID}`))
    expect(res.status).toBe(200)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://getreelstudio.com')
    expect(res.headers.get('cache-control')).toBe('no-store')
    const b = (await res.json()) as { ok: boolean; plan: string; version: string; token: string; files: { win: { url: string; name: string }; mac: { url: string } } }
    expect(b.ok).toBe(true)
    expect(b.plan).toBe('once')
    expect(b.version).toBe('0.1.2')
    expect(b.files.win.url).toBe(`https://dl.getreelstudio.com/d/${b.token}/Reel-Studio-Setup-0.1.2-x64.exe`)
    expect(b.files.mac.url).toBe(`https://dl.getreelstudio.com/d/${b.token}/Reel-Studio-0.1.2-arm64.dmg`)
    // Stripe was asked once, with the restricted key, for exactly this session
    expect(w.stripeCalls).toEqual([`GET https://api.stripe.com/v1/checkout/sessions/${SID} auth=Bearer rk_test_1234567890abcdefghijklmnop`])
    // the record: no email address anywhere in KV
    const rec = JSON.parse(w.kv.store.get(`sess:${SID}`)!)
    expect(rec).toMatchObject({ sid: SID, plan: 'once', customer: 'cus_123', source: 'claim' })
    expect(rec.emailHash).toMatch(/^[0-9a-f]{64}$/)
    const all = [...w.kv.store.entries()].map(([k, v]) => k + v).join('\n')
    expect(all.toLowerCase()).not.toContain('buyer@example.com')
    expect(w.kv.store.get(`email:${rec.emailHash}`)).toBe(SID)
  })
  it('a second visit of the thanks page uses the record, not Stripe', async () => {
    const w = world()
    await run(w, req(`/api/claim?session_id=${SID}`))
    const res = await run(w, req(`/api/claim?session_id=${SID}`))
    expect(res.status).toBe(200)
    expect(w.stripeCalls.length).toBe(1)
  })
  it('a subscription session is the monthly plan', async () => {
    const w = world({ stripe: async () => new Response(JSON.stringify(paidSession({ mode: 'subscription' }))) })
    const b = (await (await run(w, req(`/api/claim?session_id=${SID}`))).json()) as { plan: string }
    expect(b.plan).toBe('monthly')
  })
  it('unpaid, unknown and malformed sessions get nothing', async () => {
    const unpaid = world({ stripe: async () => new Response(JSON.stringify(paidSession({ payment_status: 'unpaid', status: 'open' }))) })
    expect((await run(unpaid, req(`/api/claim?session_id=${SID}`))).status).toBe(402)
    expect(unpaid.kv.store.has(`sess:${SID}`)).toBe(false)
    const unknown = world({ stripe: async () => new Response('{"error":{}}', { status: 404 }) })
    expect((await run(unknown, req(`/api/claim?session_id=${SID}`))).status).toBe(404)
    const w = world()
    expect((await run(w, req('/api/claim?session_id=cs_live_short'))).status).toBe(400)
    expect((await run(w, req('/api/claim?session_id=pi_live_aaaaaaaaaaaaaaaaaaaa'))).status).toBe(400)
    expect((await run(w, req('/api/claim'))).status).toBe(400)
    expect(w.stripeCalls.length).toBe(0)
    // a session whose id does not match what we asked for is not trusted
    const swapped = world({ stripe: async () => new Response(JSON.stringify(paidSession({ id: 'cs_live_someoneelse0000000000' }))) })
    expect((await run(swapped, req(`/api/claim?session_id=${SID}`))).status).toBe(503)
  })
  it('Stripe down is a 503, not a token', async () => {
    const w = world({ stripe: async () => new Response('', { status: 500 }) })
    expect((await run(w, req(`/api/claim?session_id=${SID}`))).status).toBe(503)
    const down = world({ stripe: async () => Promise.reject(new Error('network')) })
    expect((await run(down, req(`/api/claim?session_id=${SID}`))).status).toBe(503)
  })
  it('without secrets or a manifest: 503, Stripe never asked', async () => {
    const w = world({ secrets: false })
    expect((await run(w, req(`/api/claim?session_id=${SID}`))).status).toBe(503)
    const noRelease = world({ manifest: null })
    expect((await run(noRelease, req(`/api/claim?session_id=${SID}`))).status).toBe(503)
    expect(w.stripeCalls.length + noRelease.stripeCalls.length).toBe(0)
  })
  it('is rate limited per IP', async () => {
    const w = world()
    for (let i = 0; i < CLAIM_LIMIT.n; i++) expect((await run(w, req('/api/claim?session_id=bad'))).status).toBe(400)
    expect((await run(w, req('/api/claim?session_id=bad'))).status).toBe(429)
    expect((await run(w, req('/api/claim?session_id=bad', { ip: '198.51.100.9' }))).status).toBe(400)
  })
})

describe('GET /api/claim?token', () => {
  it('a remembered token gets links for the CURRENT version, with the same token', async () => {
    const w = world()
    const token = await mintToken(SECRET, { s: SID, p: 'once', e: Math.floor(T0 / 1000) + 1000 })
    w.kv.store.set('manifest', JSON.stringify({ ...MANIFEST, version: '0.1.3', files: { win: { ...MANIFEST.files.win, name: 'Reel-Studio-Setup-0.1.3-x64.exe', key: 'v0.1.3/w.exe' } } }))
    const b = (await (await run(w, req(`/api/claim?token=${token}`))).json()) as { version: string; token: string; files: { win: { url: string } } }
    expect(b.version).toBe('0.1.3')
    expect(b.token).toBe(token)
    expect(b.files.win.url).toContain('/Reel-Studio-Setup-0.1.3-x64.exe')
    expect(w.stripeCalls.length).toBe(0)
  })
  it('a bad or expired token is 401', async () => {
    const w = world()
    const expired = await mintToken(SECRET, { s: SID, p: 'once', e: Math.floor(T0 / 1000) - 1 })
    expect((await run(w, req(`/api/claim?token=${expired}`))).status).toBe(401)
    expect((await run(w, req('/api/claim?token=v1.x.y'))).status).toBe(401)
  })
})

describe('GET /d/<token>/<file>', () => {
  async function token(w: ReturnType<typeof world>, over: Partial<{ e: number }> = {}) {
    return mintToken(SECRET, { s: SID, p: 'once', e: over.e ?? Math.floor(w.now / 1000) + 1000 })
  }
  it('streams the file as an attachment with its size, resumable', async () => {
    const w = world()
    const res = await run(w, req(`/d/${await token(w)}/Reel-Studio-Setup-0.1.2-x64.exe`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="Reel-Studio-Setup-0.1.2-x64.exe"')
    expect(res.headers.get('content-length')).toBe('5')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('cache-control')).toBe('private, no-store')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })
  it('honours a Range (a download manager resuming)', async () => {
    const w = world()
    const res = await run(w, req(`/d/${await token(w)}/Reel-Studio-Setup-0.1.2-x64.exe`, { headers: { range: 'bytes=3-' } }))
    expect(res.status).toBe(206)
    expect(res.headers.get('content-range')).toBe('bytes 3-4/5')
    expect(res.headers.get('content-length')).toBe('2')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([4, 5]))
    const suffix = await run(w, req(`/d/${await token(w)}/Reel-Studio-Setup-0.1.2-x64.exe`, { headers: { range: 'bytes=-2' } }))
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 3-4/5')
  })
  it('an unsatisfiable Range is a 416, not a server error', async () => {
    const w = world()
    for (const range of ['bytes=600-', 'bytes=5-', 'bytes=-0']) {
      const res = await run(w, req(`/d/${await token(w)}/Reel-Studio-Setup-0.1.2-x64.exe`, { headers: { range } }))
      expect(res.status, range).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */5')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.body).toBeNull()
    }
  })
  it('If-Match / If-Unmodified-Since never make a 304; a stale If-Range gets the whole file', async () => {
    const w = world()
    const url = async () => `/d/${await token(w)}/Reel-Studio-Setup-0.1.2-x64.exe`
    expect((await run(w, req(await url(), { headers: { 'if-match': '"nope"' } }))).status).toBe(200)
    expect((await run(w, req(await url(), { headers: { 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' } }))).status).toBe(200)
    const stale = await run(w, req(await url(), { headers: { range: 'bytes=3-', 'if-range': '"etag-v0.1.1/old.exe"' } }))
    expect(stale.status).toBe(200)
    expect(new Uint8Array(await stale.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
    const fresh = await run(w, req(await url(), { headers: { range: 'bytes=3-', 'if-range': '"etag-v0.1.2/Reel-Studio-Setup-0.1.2-x64.exe"' } }))
    expect(fresh.status).toBe(206)
  })
  it('HEAD gives the size without the body', async () => {
    const w = world()
    const res = await run(w, req(`/d/${await token(w)}/Reel-Studio-0.1.2-arm64.dmg`, { method: 'HEAD' }))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-length')).toBe('3')
    expect(res.body).toBeNull()
  })
  it('If-None-Match → 304', async () => {
    const w = world()
    const res = await run(w, req(`/d/${await token(w)}/Reel-Studio-0.1.2-arm64.dmg`, { headers: { 'if-none-match': '"etag-v0.1.2/Reel-Studio-0.1.2-arm64.dmg"' } }))
    expect(res.status).toBe(304)
  })
  it('a bad, expired or missing token is a 401 page pointing at the update page', async () => {
    const w = world()
    const res = await run(w, req(`/d/${await token(w, { e: Math.floor(w.now / 1000) - 5 })}/Reel-Studio-Setup-0.1.2-x64.exe`))
    expect(res.status).toBe(401)
    expect(res.headers.get('content-type')).toContain('text/html')
    expect(await res.text()).toContain('https://getreelstudio.com/update.html')
    expect((await run(w, req('/d/nope/Reel-Studio-Setup-0.1.2-x64.exe'))).status).toBe(401)
    expect((await run(w, req('/d//Reel-Studio-Setup-0.1.2-x64.exe'))).status).toBe(401)
  })
  it('only the current release files, by exact name: no other keys, no paths', async () => {
    const w = world()
    w.r2.objects.set('secret/other.exe', new Uint8Array([1]))
    const t = await token(w)
    for (const name of ['secret/other.exe', '..%2Fsecret%2Fother.exe', 'v0.1.2/Reel-Studio-Setup-0.1.2-x64.exe', 'Reel-Studio-Setup-0.1.1-x64.exe', ''])
      expect((await run(w, req(`/d/${t}/${name}`))).status).toBe(404)
  })
  it('a file named in the manifest but missing from R2 is a 404, not a crash', async () => {
    const w = world()
    w.r2.objects.delete(MANIFEST.files.win.key)
    expect((await run(w, req(`/d/${await token(w)}/Reel-Studio-Setup-0.1.2-x64.exe`))).status).toBe(404)
  })
})

describe('POST /stripe/webhook', () => {
  const event = (session: Record<string, unknown>, type = 'checkout.session.completed') => JSON.stringify({ id: 'evt_1', type, data: { object: session } })
  it('records a paid session (email hashed) and answers 200', async () => {
    const w = world()
    const res = await run(w, await signed(event(paidSession({ mode: 'subscription' })), Math.floor(T0 / 1000)))
    expect(res.status).toBe(200)
    const rec = JSON.parse(w.kv.store.get(`sess:${SID}`)!)
    expect(rec).toMatchObject({ sid: SID, plan: 'monthly', source: 'webhook' })
    expect(w.kv.store.get(`email:${rec.emailHash}`)).toBe(SID)
    expect(w.stripeCalls.length).toBe(0)
  })
  it('a wrong or stale signature is refused and records nothing', async () => {
    const w = world()
    expect((await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000), 'test-wrong-webhook-secret-xxxxxxxxxxxxxxxxxx'))).status).toBe(400)
    expect((await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000) - 3600))).status).toBe(400)
    expect((await run(w, req('/stripe/webhook', { method: 'POST', body: event(paidSession()) }))).status).toBe(400)
    expect(w.kv.store.has(`sess:${SID}`)).toBe(false)
  })
  it('other events and unpaid sessions are acknowledged but not recorded', async () => {
    const w = world()
    expect((await run(w, await signed(event(paidSession(), 'invoice.paid'), Math.floor(T0 / 1000)))).status).toBe(200)
    expect((await run(w, await signed(event(paidSession({ payment_status: 'unpaid' })), Math.floor(T0 / 1000)))).status).toBe(200)
    expect(w.kv.store.has(`sess:${SID}`)).toBe(false)
  })
  it('the claim after a webhook does not ask Stripe', async () => {
    const w = world()
    await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000)))
    expect((await run(w, req(`/api/claim?session_id=${SID}`))).status).toBe(200)
    expect(w.stripeCalls.length).toBe(0)
  })
})

describe('POST /api/link', () => {
  const post = (email: unknown, ip?: string) => req('/api/link', { method: 'POST', body: JSON.stringify({ email }), headers: { 'content-type': 'application/json' }, ip })
  it('with Email Sending: a known buyer gets a mail with fresh links; an unknown one gets the same answer and no mail', async () => {
    const w = world({ email: true })
    await run(w, req(`/api/claim?session_id=${SID}`))
    const res = await run(w, post(' BUYER@example.com'))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, delivery: 'email' })
    await Promise.all(w.waited)
    expect(w.emails.length).toBe(1)
    const m = w.emails[0] as { to: string; from: { email: string }; subject: string; text: string; html: string }
    expect(m.to).toBe('buyer@example.com')
    expect(m.from.email).toBe('support@getreelstudio.com')
    expect(m.subject).toContain('0.1.2')
    expect(m.text).toMatch(/https:\/\/dl\.getreelstudio\.com\/d\/v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\/Reel-Studio-Setup-0\.1\.2-x64\.exe/)
    expect(m.html).toContain('Download for Mac')
    const stranger = await run(w, post('nobody@example.com'))
    expect(await stranger.json()).toEqual({ ok: true, delivery: 'email' })
    await Promise.all(w.waited)
    expect(w.emails.length).toBe(1)
  })
  it('without Email Sending: delivery is "support" and nothing is sent', async () => {
    const w = world()
    await run(w, req(`/api/claim?session_id=${SID}`))
    const res = await run(w, post('buyer@example.com'))
    expect(await res.json()).toEqual({ ok: true, delivery: 'support' })
    expect(w.waited.length).toBe(0)
  })
  it('bad input and rate limits', async () => {
    const w = world({ email: true })
    expect((await run(w, post('not-an-email'))).status).toBe(400)
    expect((await run(w, req('/api/link', { method: 'POST', body: '{' }))).status).toBe(400)
    for (let i = 0; i < LINK_LIMIT.n - 2; i++) expect((await run(w, post('a@b.co'))).status).toBe(200)
    expect((await run(w, post('a@b.co'))).status).toBe(429)
    expect((await run(w, post('a@b.co', '198.51.100.9'))).status).toBe(200)
  })
})

describe('the rest', () => {
  it('OPTIONS preflight for the API is limited to the site', async () => {
    const w = world()
    const res = await run(w, req('/api/link', { method: 'OPTIONS' }))
    expect(res.status).toBe(204)
    expect(res.headers.get('access-control-allow-origin')).toBe('https://getreelstudio.com')
    expect(res.headers.get('access-control-allow-methods')).toContain('POST')
  })
  it('/ goes to the site; unknown paths are 404; wrong methods too', async () => {
    const w = world()
    const home = await run(w, req('/'))
    expect(home.status).toBe(302)
    expect(home.headers.get('location')).toBe('https://getreelstudio.com/')
    expect((await run(w, req('/nope'))).status).toBe(404)
    expect((await run(w, req('/api/claim', { method: 'POST' }))).status).toBe(404)
    expect((await run(w, req('/stripe/webhook'))).status).toBe(404)
  })
  it('an exception inside a route is a 500, never a crash', async () => {
    const w = world()
    w.kv.get = async () => {
      throw new Error('kv down')
    }
    expect((await run(w, req('/latest.json'))).status).toBe(500)
  })
})
