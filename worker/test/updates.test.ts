import { describe, expect, it } from 'vitest'
import { handle } from '../src/app'
import { parseManifest, updateYml } from '../src/manifest'
import { mintToken } from '../src/token'
import { ADMIN, MANIFEST, SECRET, SID, T0, deps, paidSession, req, signed, world } from './fakes'

const run = (w: ReturnType<typeof world>, r: Request) => handle(r, w.env, w.ctx, deps(w))
const nowSec = Math.floor(T0 / 1000)
const SHA512_WIN = 'W'.repeat(86) + '=='
const SHA512_ZIP = 'Z'.repeat(86) + '=='
const SUB = 'sub_1AbCdEfGhIjKlMnOp'
const PI = 'pi_1AbCdEfGhIjKlMnOp'

const RELEASE = {
  ...MANIFEST,
  version: '0.1.5',
  published: '2026-11-03',
  files: {
    win: { ...MANIFEST.files.win, sha512: SHA512_WIN },
    mac: MANIFEST.files.mac,
    macZip: { name: 'Reel-Studio-0.1.2-arm64-mac.zip', key: 'v0.1.2/Reel-Studio-0.1.2-arm64-mac.zip', size: 4, sha256: 'c'.repeat(64), sha512: SHA512_ZIP }
  },
  notes: [{ version: '0.1.5', date: '2026-11-03', text: '- Updates install themselves' }]
}

/** A world with an update-ready release and the zip in R2. */
function updWorld(opts: Parameters<typeof world>[0] = {}) {
  const w = world({ manifest: RELEASE, ...opts })
  w.r2.objects.set(RELEASE.files.macZip.key, new Uint8Array([4, 3, 2, 1]))
  return w
}

const token = (over: { s?: string; p?: 'once' | 'monthly'; e?: number } = {}) => mintToken(SECRET, { s: SID, p: 'once', e: nowSec + 86400, ...over })
const bearer = (t: string) => ({ headers: { authorization: `Bearer ${t}` } })
const event = (type: string, object: Record<string, unknown>, created = nowSec) => JSON.stringify({ id: `evt_${type}_${created}`, type, created, data: { object } })
async function send(w: ReturnType<typeof world>, type: string, object: Record<string, unknown>, created = nowSec) {
  const res = await run(w, await signed(event(type, object, created), nowSec))
  expect(res.status).toBe(200)
}
/** A monthly purchase on file, as the webhook records it. */
async function monthly(w: ReturnType<typeof world>) {
  await send(w, 'checkout.session.completed', paidSession({ mode: 'subscription', subscription: SUB, payment_intent: null }))
  return token({ p: 'monthly' })
}
/** A one-time purchase on file. */
async function once(w: ReturnType<typeof world>) {
  await send(w, 'checkout.session.completed', paidSession({ payment_intent: PI }))
  return token()
}

describe('the update feed /u/', () => {
  it('renders latest.yml for Windows from the manifest: the installer, its sha512 and size, relative URL', async () => {
    const w = updWorld()
    const t = await once(w)
    const res = await run(w, req('/u/latest.yml', bearer(t)))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/yaml')
    expect(res.headers.get('cache-control')).toBe('no-store')
    expect(await res.text()).toBe(
      [
        'version: 0.1.5',
        'files:',
        '  - url: Reel-Studio-Setup-0.1.2-x64.exe',
        `    sha512: ${SHA512_WIN}`,
        '    size: 5',
        'path: Reel-Studio-Setup-0.1.2-x64.exe',
        `sha512: ${SHA512_WIN}`,
        "releaseDate: '2026-11-03T00:00:00.000Z'",
        ''
      ].join('\n')
    )
  })
  it('renders latest-mac.yml naming the zip, never the dmg', async () => {
    const w = updWorld()
    const t = await once(w)
    const yml = await (await run(w, req('/u/latest-mac.yml', bearer(t)))).text()
    expect(yml).toContain('  - url: Reel-Studio-0.1.2-arm64-mac.zip')
    expect(yml).toContain(`sha512: ${SHA512_ZIP}`)
    expect(yml).not.toContain('.dmg')
  })
  it('streams the update files (resumable); the dmg and unknown names are not on the feed', async () => {
    const w = updWorld()
    const t = await once(w)
    const zip = await run(w, req('/u/Reel-Studio-0.1.2-arm64-mac.zip', bearer(t)))
    expect(zip.status).toBe(200)
    expect(new Uint8Array(await zip.arrayBuffer())).toEqual(new Uint8Array([4, 3, 2, 1]))
    const part = await run(w, req('/u/Reel-Studio-Setup-0.1.2-x64.exe', { headers: { authorization: `Bearer ${t}`, range: 'bytes=1-2' } }))
    expect(part.status).toBe(206)
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(new Uint8Array([2, 3]))
    expect((await run(w, req('/u/Reel-Studio-0.1.2-arm64.dmg', bearer(t)))).status).toBe(404)
    expect((await run(w, req('/u/..%2Fmanifest', bearer(t)))).status).toBe(404)
    // and /d/ does not hand out the updater's zip
    expect((await run(w, req(`/d/${t}/Reel-Studio-0.1.2-arm64-mac.zip`))).status).toBe(404)
  })
  it('HEAD answers without a body', async () => {
    const w = updWorld()
    const t = await once(w)
    const res = await run(w, req('/u/latest.yml', { method: 'HEAD', ...bearer(t) }))
    expect(res.status).toBe(200)
    expect(await res.text()).toBe('')
  })
  it('no key, a key in the URL only, or a forged key: 401', async () => {
    const w = updWorld()
    const t = await once(w)
    expect((await run(w, req('/u/latest.yml'))).status).toBe(401)
    expect((await run(w, req(`/u/latest.yml?token=${t}`))).status).toBe(401)
    expect((await run(w, req('/u/latest.yml', bearer(await mintToken('another-secret-with-plenty-of-bytes-000000', { s: SID, p: 'once', e: nowSec + 99 }))))).status).toBe(401)
    expect((await run(w, req('/u/latest.yml', bearer(t.slice(0, -2) + 'xx')))).status).toBe(401)
  })
  it("ignores the key's age: a paying buyer is never cut off because a link is old", async () => {
    const w = updWorld()
    await once(w)
    const old = await token({ e: nowSec - 86400 * 30 })
    expect((await run(w, req('/u/latest.yml', bearer(old)))).status).toBe(200)
    // while an old /d/ link still expires as before
    expect((await run(w, req(`/d/${old}/Reel-Studio-Setup-0.1.2-x64.exe`))).status).toBe(401)
  })
  it('a validly signed key for a purchase not on file: 403', async () => {
    const w = updWorld()
    const res = await run(w, req('/u/latest.yml', bearer(await token())))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'not entitled', reason: 'unknown purchase' })
  })
  it('a release without sha512 or without a zip has no feed for that platform', async () => {
    const w = world()
    await once(w)
    const t = await token()
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(404)
    expect((await run(w, req('/u/latest-mac.yml', bearer(t)))).status).toBe(404)
  })
})

describe('monthly: updates while the subscription is live', () => {
  it('active → 200; deleted (canceled) → 403 on the feed, on /d/ and on the claim; the link email is not sent', async () => {
    const w = updWorld({ email: true })
    const t = await monthly(w)
    await Promise.all(w.waited)
    await send(w, 'customer.subscription.created', { id: SUB, object: 'subscription', status: 'active', customer: 'cus_123' })
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(200)

    await send(w, 'customer.subscription.deleted', { id: SUB, object: 'subscription', status: 'canceled', customer: 'cus_123' }, nowSec + 100)
    const feed = await run(w, req('/u/latest.yml', bearer(t)))
    expect(feed.status).toBe(403)
    expect(await feed.json()).toEqual({ error: 'not entitled', reason: 'subscription ended' })
    const dl = await run(w, req(`/d/${t}/Reel-Studio-Setup-0.1.2-x64.exe`))
    expect(dl.status).toBe(403)
    expect(await dl.text()).toContain('needs an active subscription')
    expect((await run(w, req(`/api/claim?token=${t}`))).status).toBe(403)
    expect((await run(w, req(`/api/claim?session_id=${SID}`))).status).toBe(403)

    const before = w.emails.length
    await run(w, req('/api/link', { method: 'POST', body: JSON.stringify({ email: 'buyer@example.com' }), headers: { 'content-type': 'application/json' } }))
    await Promise.all(w.waited)
    expect(w.emails.length).toBe(before)
  })
  it('past_due (Stripe still retrying the card) keeps updating; unpaid stops', async () => {
    const w = updWorld()
    const t = await monthly(w)
    await send(w, 'customer.subscription.updated', { id: SUB, status: 'past_due' })
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(200)
    await send(w, 'customer.subscription.updated', { id: SUB, status: 'unpaid' }, nowSec + 1)
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(403)
  })
  it('events out of order: an older "active" never revives a newer "canceled"', async () => {
    const w = updWorld()
    const t = await monthly(w)
    await send(w, 'customer.subscription.deleted', { id: SUB, status: 'canceled' }, nowSec + 500)
    await send(w, 'customer.subscription.updated', { id: SUB, status: 'active' }, nowSec + 10)
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(403)
  })
  it('subscription events before the purchase is on file still count', async () => {
    const w = updWorld()
    await send(w, 'customer.subscription.deleted', { id: SUB, status: 'canceled' }, nowSec + 5)
    const t = await monthly(w)
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(403)
  })
  it('created as incomplete and made active in the same second, in either order: entitled', async () => {
    const w = updWorld()
    const t = await monthly(w)
    await send(w, 'customer.subscription.updated', { id: SUB, status: 'active' })
    await send(w, 'customer.subscription.created', { id: SUB, status: 'incomplete' })
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(200)
  })
  it('a paid monthly session with no subscription event yet: entitled', async () => {
    const w = updWorld()
    const t = await monthly(w)
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(200)
    const rec = JSON.parse(w.kv.store.get(`sess:${SID}`)!)
    expect(rec.subscription).toBe(SUB)
  })
})

describe('one-time: all future updates, unless refunded or disputed', () => {
  it('a full refund ends it; a partial refund does not', async () => {
    const w = updWorld()
    const t = await once(w)
    await send(w, 'charge.refunded', { id: 'ch_1', payment_intent: PI, refunded: false, amount_refunded: 1000 })
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(200)
    await send(w, 'charge.refunded', { id: 'ch_1', payment_intent: PI, refunded: true, amount_refunded: 9900 }, nowSec + 1)
    const res = await run(w, req('/u/latest.yml', bearer(t)))
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: 'not entitled', reason: 'refunded' })
  })
  it('a dispute suspends it; won restores it; lost keeps it off', async () => {
    const w = updWorld()
    const t = await once(w)
    await send(w, 'charge.dispute.created', { id: 'dp_1', payment_intent: PI, status: 'needs_response' })
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(403)
    await send(w, 'charge.dispute.closed', { id: 'dp_1', payment_intent: PI, status: 'won' }, nowSec + 60)
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(200)
    await send(w, 'charge.dispute.closed', { id: 'dp_1', payment_intent: PI, status: 'lost' }, nowSec + 120)
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(403)
  })
  it('a refund before the purchase is on file still counts', async () => {
    const w = updWorld()
    await send(w, 'charge.refunded', { id: 'ch_1', payment_intent: PI, refunded: true })
    const t = await once(w)
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(403)
  })
  it('a purchase recorded before payment intents were kept (no PI on file) stays entitled', async () => {
    const w = updWorld()
    await send(w, 'checkout.session.completed', paidSession())
    expect((await run(w, req('/u/latest.yml', bearer(await token())))).status).toBe(200)
  })
  it('unknown, malformed or unsigned events change nothing', async () => {
    const w = updWorld()
    const t = await once(w)
    await send(w, 'charge.refunded', { id: 'ch_1', payment_intent: 'not-a-pi', refunded: true })
    await send(w, 'customer.subscription.deleted', { id: 'nope', status: 'canceled' })
    await send(w, 'invoice.paid', { id: 'in_1' })
    const forged = await signed(event('charge.refunded', { payment_intent: PI, refunded: true }), nowSec, 'wrong-secret-with-plenty-of-bytes-0123456789')
    expect((await run(w, forged)).status).toBe(400)
    expect((await run(w, req('/u/latest.yml', bearer(t)))).status).toBe(200)
  })
})

describe('the receipt email', () => {
  it('links the page that turns on automatic updates, with the key in the fragment, and promises future updates', async () => {
    const w = updWorld({ email: true })
    await send(w, 'checkout.session.completed', paidSession({ payment_intent: PI }))
    await Promise.all(w.waited)
    const m = w.emails[0] as { text: string; html: string }
    const link = /https:\/\/getreelstudio\.com\/updates\.html#key=(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)/.exec(m.text)
    expect(link).not.toBeNull()
    expect((await run(w, req('/u/latest.yml', bearer(link![1])))).status).toBe(200)
    expect(m.html).toContain('updates.html#key=')
    expect(m.text).toContain('includes all future updates')
    expect(m.text).not.toContain('1.x')
  })
})

describe('the manifest', () => {
  it('keeps sha512, the zip and up to five notes; drops malformed ones', () => {
    const m = parseManifest({ ...RELEASE, notes: [...Array(7)].map((_, i) => ({ version: `0.1.${9 - i}`, date: '2026-11-0' + (i + 1), text: 'x' })).concat([{ version: 'bad', date: 'x', text: 'y' }] as never) })!
    expect(m.files.macZip?.sha512).toBe(SHA512_ZIP)
    expect(m.notes!.length).toBe(5)
    expect(m.notes![0].version).toBe('0.1.9')
    expect(parseManifest({ ...RELEASE, files: { ...RELEASE.files, win: { ...RELEASE.files.win, sha512: 'not base64' } } })!.files.win).toBeUndefined()
  })
  it('latest.json carries the notes', async () => {
    const w = updWorld()
    const b = (await (await run(w, req('/latest.json'))).json()) as { notes: unknown[] }
    expect(b.notes).toEqual(RELEASE.notes)
  })
  it('a release without a published date still renders a valid yml', () => {
    const m = parseManifest({ ...RELEASE, published: undefined })!
    expect(updateYml(m, 'win')).toContain("releaseDate: '1970-01-01T00:00:00.000Z'")
  })
})

describe('admin', () => {
  const auth = { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' }
  it('refuses a manifest whose zip is not in the bucket', async () => {
    const w = world({ admin: true })
    const res = await run(w, req('/admin/manifest', { method: 'PUT', headers: auth, body: JSON.stringify(RELEASE) }))
    expect(res.status).toBe(400)
    expect(JSON.stringify(await res.json())).toContain('arm64-mac.zip')
  })
  it('/admin/purchase shows the record (no email hash) and its entitlement', async () => {
    const w = updWorld({ admin: true })
    await monthly(w)
    await send(w, 'customer.subscription.deleted', { id: SUB, status: 'canceled' })
    const b = (await (await run(w, req(`/admin/purchase?sid=${SID}`, { headers: auth }))).json()) as Record<string, unknown>
    expect(b.entitlement).toEqual({ ok: false, reason: 'subscription ended' })
    expect(b.subscription).toEqual({ status: 'canceled', at: nowSec })
    expect(JSON.stringify(b)).not.toContain('emailHash')
  })
})
