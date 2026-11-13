import { describe, expect, it } from 'vitest'
import { handle } from '../src/app'
import { supportNotice } from '../src/email'
import { MAX_SCREENSHOT, NOTICE_DAY_LIMIT, REPORT_PREFIX, SHOT_PREFIX, SUPPORT_IP_LIMIT, SUPPORT_KEY_LIMIT, cleanText, firstLine, imageType, refFor } from '../src/support'
import { mintToken } from '../src/token'
import { ADMIN, SECRET, SID, SUPPORT_ADMIN, T0, deps, req, world } from './fakes'

type W = ReturnType<typeof world>
const run = (w: W, r: Request) => handle(r, w.env, w.ctx, deps(w))
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 1, 2, 3])
const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70])

function form(fields: Record<string, string | Blob | undefined> = {}): FormData {
  const f = new FormData()
  const all: Record<string, string | Blob | undefined> = { what: 'Export stopped at 80%\nand the app froze', expected: 'A finished reel', appVersion: '0.1.6', os: 'Windows 10.0.26200 x64', ...fields }
  for (const [k, v] of Object.entries(all)) if (v !== undefined) f.append(k, v)
  return f
}
const report = (f: FormData = form(), init: { headers?: Record<string, string>; ip?: string } = {}) => req('/v1/support', { method: 'POST', body: f, headers: init.headers, ip: init.ip })
const reports = (w: W) => [...w.kv.store.keys()].filter((k) => k.startsWith(REPORT_PREFIX)).map((k) => JSON.parse(w.kv.store.get(k)!))
const adminGet = (path: string, secret = ADMIN) => req(path, { headers: { authorization: `Bearer ${secret}` } })
const keyFor = async (sid = SID, plan: 'once' | 'monthly' = 'once', e = Math.floor(T0 / 1000) + 86400) => mintToken(SECRET, { s: sid, p: plan, e })

describe('POST /v1/support', () => {
  it('stores a report with an id and status new, and answers the id', async () => {
    const w = world()
    const res = await run(w, report())
    expect(res.status).toBe(201)
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
    const b = (await res.json()) as { ok: boolean; id: string }
    expect(b.ok).toBe(true)
    expect(b.id).toMatch(/^RS-[0-9A-HJKMNP-TV-Z]{8}$/)
    const [r] = reports(w)
    expect(r).toMatchObject({ id: b.id, status: 'new', what: 'Export stopped at 80%\nand the app froze', expected: 'A finished reel', email: null, diagnostics: '', appVersion: '0.1.6', os: 'Windows 10.0.26200 x64', screenshot: null, key: { status: 'none' }, created: T0 })
    expect(r.ref).toBe(refFor(T0, b.id))
    // kept 180 days, and listable without reading it
    const k = REPORT_PREFIX + r.ref
    expect(w.kv.expiration.get(k)).toBe(Math.floor(T0 / 1000) + 180 * 86400)
    expect(w.kv.meta.get(k)).toMatchObject({ id: b.id, status: 'new', first: 'Export stopped at 80%', shot: false, email: false })
  })

  it('takes the optional email, diagnostics and a PNG or JPEG screenshot (stored apart, same expiry)', async () => {
    const w = world()
    const res = await run(w, report(form({ email: ' Creator@Example.com ', diagnostics: 'Reel Studio 0.1.6\nGPU: none', screenshot: new File([PNG], 'shot.png', { type: 'image/png' }) })))
    expect(res.status).toBe(201)
    const [r] = reports(w)
    expect(r.email).toBe('creator@example.com')
    expect(r.diagnostics).toBe('Reel Studio 0.1.6\nGPU: none')
    expect(r.screenshot).toEqual({ type: 'image/png', size: PNG.length })
    expect(w.kv.bytes.get(SHOT_PREFIX + r.ref)).toEqual(PNG)
    expect(w.kv.expiration.get(SHOT_PREFIX + r.ref)).toBe(w.kv.expiration.get(REPORT_PREFIX + r.ref))
    const w2 = world()
    expect((await run(w2, report(form({ screenshot: new File([JPEG], 'a.jpg') })))).status).toBe(201)
    expect(reports(w2)[0].screenshot.type).toBe('image/jpeg')
  })

  it('an empty screenshot field is no screenshot', async () => {
    const w = world()
    expect((await run(w, report(form({ screenshot: new File([], 'empty.png') })))).status).toBe(201)
    expect(reports(w)[0].screenshot).toBeNull()
  })

  it('refuses what it cannot take, and says which field', async () => {
    const w = world()
    let n = 0
    const bad = async (f: FormData, status: number, field?: string) => {
      const res = await run(w, report(f, { ip: `10.9.9.${n++}` }))
      expect(res.status).toBe(status)
      if (field) expect(((await res.json()) as { field: string }).field).toBe(field)
    }
    await bad(form({ what: '   ' }), 400, 'what')
    await bad(form({ what: 'x'.repeat(5001) }), 400, 'what')
    await bad(form({ expected: 'x'.repeat(3001) }), 400, 'expected')
    await bad(form({ diagnostics: 'x'.repeat(200_001) }), 400, 'diagnostics')
    await bad(form({ appVersion: undefined }), 400, 'appVersion')
    await bad(form({ appVersion: '0.1.6; drop' }), 400, 'appVersion')
    await bad(form({ os: undefined }), 400, 'os')
    await bad(form({ os: 'x'.repeat(121) }), 400, 'os')
    await bad(form({ email: 'not an email' }), 400, 'email')
    await bad(form({ email: 'a@example.com>, b@example.com' }), 400, 'email')
    await bad(form({ screenshot: new File([new TextEncoder().encode('<svg onload=alert(1)>')], 'x.png', { type: 'image/png' }) }), 400, 'screenshot')
    await bad(form({ screenshot: 'iVBORw0KGgo=' }), 400, 'screenshot')
    await bad(form({ what: new File(['x'], 'what.txt') }), 400, 'what')
    // a JSON body is not a form
    expect((await run(w, req('/v1/support', { method: 'POST', body: '{"what":"x"}', headers: { 'content-type': 'application/json' } }))).status).toBe(415)
    expect(reports(w)).toEqual([])
  })

  it('caps the screenshot at 2 MB and the whole request a little above it', async () => {
    const w = world()
    const big = new Uint8Array(MAX_SCREENSHOT + 1)
    big.set(PNG)
    expect((await run(w, report(form({ screenshot: new File([big], 'big.png') }))) ).status).toBe(413)
    const ok = new Uint8Array(MAX_SCREENSHOT)
    ok.set(PNG)
    expect((await run(w, report(form({ screenshot: new File([ok], 'ok.png') }))) ).status).toBe(201)
    // a declared Content-Length over the cap is refused before reading
    const r = req('/v1/support', { method: 'POST', body: 'x', headers: { 'content-type': 'multipart/form-data; boundary=x', 'content-length': String(10 * 1024 * 1024) } })
    expect((await run(w, r)).status).toBe(413)
    // and so is a body that turns out larger than it said (no Content-Length, streamed)
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 8; i++) c.enqueue(new Uint8Array(512 * 1024))
        c.close()
      }
    })
    const streamed = new Request('https://dl.getreelstudio.com/v1/support', { method: 'POST', body: stream, headers: { 'content-type': 'multipart/form-data; boundary=x', 'cf-connecting-ip': '203.0.113.9' }, duplex: 'half' } as RequestInit)
    expect((await run(w, streamed)).status).toBe(413)
    expect(reports(w).length).toBe(1)
  })

  it('strips control characters and turns CRLF into LF', async () => {
    expect(cleanText('  a\r\nb\u0000c‮d\te  ')).toBe('a\nbcd\te')
    expect(firstLine('\n\n  first   line \nsecond')).toBe('first line')
    expect(firstLine('y'.repeat(200)).length).toBe(80)
    expect(imageType(PNG)).toBe('image/png')
    expect(imageType(JPEG)).toBe('image/jpeg')
    expect(imageType(new Uint8Array([0x47, 0x49, 0x46, 0x38]))).toBeNull()
    const w = world()
    await run(w, report(form({ os: 'macOS\n15.1\tarm64', what: 'line one\r\nline two' })))
    expect(reports(w)[0]).toMatchObject({ os: 'macOS 15.1 arm64', what: 'line one\nline two' })
  })

  it('a key says whose report it is; no key, or one that is not ours, is still taken', async () => {
    const w = world()
    // a purchase on file
    await run(w, req(`/api/claim?session_id=${SID}`))
    const key = await keyFor()
    expect((await run(w, report(form(), { headers: { authorization: `Bearer ${key}` } }))).status).toBe(201)
    expect((await run(w, report(form(), { headers: { authorization: 'Bearer v1.forged.key' } }))).status).toBe(201)
    // an expired key still identifies the buyer (as the update feed: the age does not matter)
    const old = await keyFor(SID, 'once', Math.floor(T0 / 1000) - 10)
    expect((await run(w, report(form(), { headers: { authorization: `Bearer ${old}` } }))).status).toBe(201)
    // a key for a purchase that is not on file
    const other = await keyFor('cs_live_notonfile0000000000000000', 'monthly')
    expect((await run(w, report(form(), { headers: { authorization: `Bearer ${other}` } }))).status).toBe(201)
    const keys = reports(w).map((r) => r.key)
    expect(keys).toContainEqual({ status: 'valid', sid: SID, plan: 'once', onFile: true, entitled: true })
    expect(keys).toContainEqual({ status: 'invalid' })
    expect(keys).toContainEqual({ status: 'valid', sid: 'cs_live_notonfile0000000000000000', plan: 'monthly', onFile: false })
    expect(keys.filter((k) => k.sid === SID).length).toBe(2)
    // the key itself is never stored
    expect([...w.kv.store.values()].join('\n')).not.toContain(key)
  })

  it('a refunded purchase is marked as no longer entitled, and the report is taken', async () => {
    const w = world()
    await run(w, req(`/api/claim?session_id=${SID}`))
    const rec = JSON.parse(w.kv.store.get(`sess:${SID}`)!)
    rec.paymentIntent = 'pi_1234567890abcdef'
    w.kv.store.set(`sess:${SID}`, JSON.stringify(rec))
    w.kv.store.set('pay:pi_1234567890abcdef', JSON.stringify({ refunded: true, at: 1 }))
    expect((await run(w, report(form(), { headers: { authorization: `Bearer ${await keyFor()}` } }))).status).toBe(201)
    expect(reports(w)[0].key).toEqual({ status: 'valid', sid: SID, plan: 'once', onFile: true, entitled: false, reason: 'refunded' })
  })

  it('rate-limits per IP and per key', async () => {
    const w = world()
    for (let i = 0; i < SUPPORT_IP_LIMIT.n; i++) expect((await run(w, report(form(), { ip: '198.51.100.1' }))).status).toBe(201)
    expect((await run(w, report(form(), { ip: '198.51.100.1' }))).status).toBe(429)
    expect((await run(w, report(form(), { ip: '198.51.100.2' }))).status).toBe(201)
    // next hour the IP may report again
    w.now += SUPPORT_IP_LIMIT.windowSec * 1000
    expect((await run(w, report(form(), { ip: '198.51.100.1' }))).status).toBe(201)

    const k = world()
    const key = await keyFor()
    for (let i = 0; i < SUPPORT_KEY_LIMIT.n; i++) expect((await run(k, report(form(), { ip: `192.0.2.${i}`, headers: { authorization: `Bearer ${key}` } }))).status).toBe(201)
    expect((await run(k, report(form(), { ip: '192.0.2.200', headers: { authorization: `Bearer ${key}` } }))).status).toBe(429)
    // the same new IP without the key is fine
    expect((await run(k, report(form(), { ip: '192.0.2.200' }))).status).toBe(201)
  })
})

describe('the notice email', () => {
  type Mail = { to: string; from: { email: string }; replyTo: string; subject: string; text: string; html?: string; attachments?: unknown }
  it('goes to support with the id and the first lines, links the dashboard, attaches nothing', async () => {
    const w = world({ email: true })
    const what = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n')
    const res = await run(w, report(form({ what, email: 'creator@example.com', diagnostics: 'SECRET-DIAG', screenshot: new File([PNG], 's.png') })))
    const { id } = (await res.json()) as { id: string }
    await Promise.all(w.waited)
    expect(w.emails.length).toBe(1)
    const m = w.emails[0] as Mail
    expect(m.to).toBe('support@getreelstudio.com')
    expect(m.from.email).toBe('support@getreelstudio.com')
    expect(m.replyTo).toBe('creator@example.com')
    expect(m.subject).toBe(`Report ${id}: line 1`)
    expect(m.text).toContain(`Report ${id}`)
    expect(m.text).toContain('line 8')
    expect(m.text).not.toContain('line 9')
    expect(m.text).toContain('Screenshot: yes')
    expect(m.text).not.toContain('SECRET-DIAG')
    expect(m.text).toContain(`https://dl.getreelstudio.com/admin/support#${reports(w)[0].ref}`)
    expect(m.attachments).toBeUndefined()
    expect(m.html).toBeUndefined()
    expect(reports(w)[0].noticed).toBe(true)
  })
  it('a subject never carries a newline', () => {
    const n = supportNotice({ id: 'RS-AAAAAAAA', created: T0, what: '\n  Bcc: x@example.com\r\nmore', expected: '', email: null, appVersion: '0.1.6', os: 'x', screenshot: null, diagnostics: '', key: { status: 'none' } }, 'https://x')
    expect(n.subject).toBe('Report RS-AAAAAAAA: Bcc: x@example.com')
    expect(n.subject).not.toMatch(/[\r\n]/)
  })
  it('a refused Reply-To is sent again without it; a failed send keeps the report', async () => {
    const sent: Mail[] = []
    const w = world({ email: async (m: unknown) => { if ((m as Mail).replyTo !== 'support@getreelstudio.com') throw Object.assign(new Error('bad'), { code: 'E_HEADER' }); sent.push(m as Mail) } })
    expect((await run(w, report(form({ email: 'odd@example.com' })))).status).toBe(201)
    await Promise.all(w.waited)
    expect(sent.length).toBe(1)
    const down = world({ email: async () => { throw new Error('down') } })
    expect((await run(down, report())).status).toBe(201)
    await Promise.all(down.waited)
    expect(reports(down)[0]).toMatchObject({ status: 'new', noticed: false })
  })
  it('no email binding (staging): the report is stored, nothing is sent', async () => {
    const w = world()
    expect((await run(w, report())).status).toBe(201)
    expect(reports(w)[0].noticed).toBe(false)
  })
  it('at most NOTICE_DAY_LIMIT notices a day; reports past it are still stored', async () => {
    const w = world({ email: true })
    for (let i = 0; i < NOTICE_DAY_LIMIT.n + 2; i++) await run(w, report(form(), { ip: `10.0.${Math.floor(i / 200)}.${i % 200}` }))
    await Promise.all(w.waited)
    expect(w.emails.length).toBe(NOTICE_DAY_LIMIT.n)
    expect(reports(w).length).toBe(NOTICE_DAY_LIMIT.n + 2)
  })
})

describe('/admin/support', () => {
  it('without any admin secret configured, everything there is a 404, the page too', async () => {
    const w = world()
    expect((await run(w, req('/admin/support'))).status).toBe(404)
    expect((await run(w, req('/admin/support/app.js'))).status).toBe(404)
    expect((await run(w, adminGet('/admin/support/api/reports'))).status).toBe(404)
  })

  it('the page and its script hold no data and lock themselves down', async () => {
    const w = world({ admin: true })
    await run(w, report(form({ what: 'PRIVATE-TEXT' })))
    const page = await run(w, req('/admin/support'))
    expect(page.status).toBe(200)
    const html = await page.text()
    expect(html).not.toContain('PRIVATE-TEXT')
    expect(page.headers.get('content-security-policy')).toContain("frame-ancestors 'none'")
    expect(page.headers.get('content-security-policy')).toContain("script-src 'self'")
    expect(page.headers.get('x-robots-tag')).toContain('noindex')
    expect(page.headers.get('cache-control')).toBe('no-store')
    const js = await (await run(w, req('/admin/support/app.js'))).text()
    expect(js).toContain('/admin/support/api/')
    // user text only ever goes in through textContent
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write/)
  })

  it('the api needs the admin secret (or the support-only one); a wrong one is 401', async () => {
    const w = world({ admin: true, supportAdmin: true })
    await run(w, report())
    expect((await run(w, req('/admin/support/api/reports'))).status).toBe(401)
    expect((await run(w, adminGet('/admin/support/api/reports', ADMIN.slice(0, -1) + 'x'))).status).toBe(401)
    expect((await run(w, adminGet('/admin/support/api/reports', 'Basic ' + ADMIN))).status).toBe(401)
    expect((await run(w, adminGet('/admin/support/api/reports'))).status).toBe(200)
    expect((await run(w, adminGet('/admin/support/api/reports', SUPPORT_ADMIN))).status).toBe(200)
  })

  it('the support-only secret opens nothing outside /admin/support', async () => {
    const w = world({ admin: true, supportAdmin: true })
    expect((await run(w, adminGet('/admin/objects', SUPPORT_ADMIN))).status).toBe(401)
    expect((await run(w, adminGet(`/admin/purchase?sid=${SID}`, SUPPORT_ADMIN))).status).toBe(401)
    // and on its own (no ADMIN_SECRET) the other admin routes do not exist at all
    const only = world({ supportAdmin: true })
    expect((await run(only, adminGet('/admin/objects', SUPPORT_ADMIN))).status).toBe(404)
    expect((await run(only, adminGet('/admin/support/api/reports', SUPPORT_ADMIN))).status).toBe(200)
  })

  it('lists newest first, filters by status, pages with a cursor', async () => {
    const w = world({ admin: true })
    const ids: string[] = []
    for (let i = 0; i < 3; i++) {
      w.now = T0 + i * 1000
      ids.push(((await (await run(w, report(form({ what: `report ${i}` }), { ip: `10.1.1.${i}` }))).json()) as { id: string }).id)
    }
    const b = (await (await run(w, adminGet('/admin/support/api/reports'))).json()) as { reports: { id: string; first: string; status: string; ref: string }[]; cursor: string | null }
    expect(b.reports.map((r) => r.id)).toEqual([...ids].reverse())
    expect(b.reports[0]).toMatchObject({ first: 'report 2', status: 'new' })
    expect(b.cursor).toBeNull()
    // set the oldest triaged; filter
    const oldest = b.reports[2].ref
    const post = req(`/admin/support/api/report?ref=${oldest}`, { method: 'POST', body: JSON.stringify({ status: 'triaged', note: 'repro on 0.1.6' }), headers: { authorization: `Bearer ${ADMIN}` } })
    expect((await run(w, post)).status).toBe(200)
    const t = (await (await run(w, adminGet('/admin/support/api/reports?status=triaged'))).json()) as { reports: { id: string }[] }
    expect(t.reports.map((r) => r.id)).toEqual([ids[0]])
    expect((await run(w, adminGet('/admin/support/api/reports?status=bogus'))).status).toBe(400)
  })

  it('pages past 100', async () => {
    const w = world({ admin: true })
    for (let i = 0; i < 105; i++) {
      w.now = T0 + i
      await run(w, report(form(), { ip: `10.2.${Math.floor(i / 9)}.${i % 9}` }))
    }
    const p1 = (await (await run(w, adminGet('/admin/support/api/reports'))).json()) as { reports: unknown[]; cursor: string }
    expect(p1.reports.length).toBe(100)
    expect(p1.cursor).toBeTruthy()
    const p2 = (await (await run(w, adminGet(`/admin/support/api/reports?cursor=${p1.cursor}`))).json()) as { reports: unknown[]; cursor: string | null }
    expect(p2.reports.length).toBe(5)
    expect(p2.cursor).toBeNull()
  })

  it('shows one report and its screenshot', async () => {
    const w = world({ admin: true })
    await run(w, report(form({ diagnostics: 'diag text', screenshot: new File([PNG], 's.png') })))
    const [r] = reports(w)
    const one = (await (await run(w, adminGet(`/admin/support/api/report?ref=${r.ref}`))).json()) as { report: { id: string; diagnostics: string } }
    expect(one.report).toMatchObject({ id: r.id, diagnostics: 'diag text' })
    const shot = await run(w, adminGet(`/admin/support/api/screenshot?ref=${r.ref}`))
    expect(shot.status).toBe(200)
    expect(shot.headers.get('content-type')).toBe('image/png')
    expect(shot.headers.get('x-content-type-options')).toBe('nosniff')
    expect(new Uint8Array(await shot.arrayBuffer())).toEqual(PNG)
    expect((await run(w, adminGet(`/admin/support/api/report?ref=../../sess:${SID}`))).status).toBe(400)
    expect((await run(w, adminGet(`/admin/support/api/report?ref=${refFor(T0, 'RS-ZZZZZZZZ')}`))).status).toBe(404)
    // a report without a screenshot has none to show
    const w2 = world({ admin: true })
    await run(w2, report())
    expect((await run(w2, adminGet(`/admin/support/api/screenshot?ref=${reports(w2)[0].ref}`))).status).toBe(404)
  })

  it('sets status and note; fixed needs a version; the expiry stays the same', async () => {
    const w = world({ admin: true })
    await run(w, report(form({ screenshot: new File([PNG], 's.png') })))
    const [r] = reports(w)
    const key = REPORT_PREFIX + r.ref
    const before = w.kv.expiration.get(key)
    const set = (body: unknown) => run(w, req(`/admin/support/api/report?ref=${r.ref}`, { method: 'POST', body: JSON.stringify(body), headers: { authorization: `Bearer ${ADMIN}` } }))
    expect((await set({ status: 'fixed' })).status).toBe(400)
    expect((await set({ status: 'fixed', fixedIn: 'soon!' })).status).toBe(400)
    expect((await set({ status: 'closed' })).status).toBe(400)
    expect((await set({ status: 'triaged', note: 'n'.repeat(2001) })).status).toBe(400)
    w.now += 5000
    expect((await set({ status: 'fixed', fixedIn: 'v0.1.7', note: 'export race, #180' })).status).toBe(200)
    expect(reports(w)[0]).toMatchObject({ status: 'fixed', fixedIn: '0.1.7', note: 'export race, #180', updatedAt: w.now })
    expect(w.kv.meta.get(key)).toMatchObject({ status: 'fixed', fixedIn: '0.1.7' })
    expect(w.kv.expiration.get(key)).toBe(before)
    // leaving the note out keeps it; another status drops the version
    expect((await set({ status: 'wontfix' })).status).toBe(200)
    expect(reports(w)[0]).toMatchObject({ status: 'wontfix', fixedIn: null, note: 'export race, #180' })
    // the screenshot is untouched by a status change
    expect(w.kv.bytes.get(SHOT_PREFIX + r.ref)).toEqual(PNG)
  })

  it('deletes a report and its screenshot', async () => {
    const w = world({ admin: true })
    await run(w, report(form({ screenshot: new File([PNG], 's.png') })))
    const [r] = reports(w)
    const del = await run(w, req(`/admin/support/api/report?ref=${r.ref}`, { method: 'DELETE', headers: { authorization: `Bearer ${ADMIN}` } }))
    expect(del.status).toBe(200)
    expect(w.kv.store.has(REPORT_PREFIX + r.ref)).toBe(false)
    expect(w.kv.bytes.has(SHOT_PREFIX + r.ref)).toBe(false)
  })

  it('no public route reads a report', async () => {
    const w = world({ admin: true })
    await run(w, report(form({ screenshot: new File([PNG], 's.png') })))
    const [r] = reports(w)
    for (const p of ['/v1/support', `/v1/support?ref=${r.ref}`, `/source/${r.ref}`, `/d/x/${r.ref}`, '/support', '/api/support']) {
      const res = await run(w, req(p))
      expect(res.status, p).not.toBe(200)
      expect(await res.text()).not.toContain(r.id)
    }
  })
})
