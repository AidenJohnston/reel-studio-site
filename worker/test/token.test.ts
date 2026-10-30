import { describe, expect, it } from 'vitest'
import { TOKEN_DAYS, b64url, fromB64url, hashEmail, mintToken, normalizeEmail, timingSafeEqual, verifyToken } from '../src/token'
import { verifyStripeSignature } from '../src/stripe'
import { parseManifest, publicLatest } from '../src/manifest'
import { SECRET } from './fakes'

const NOW = 1_800_000_000

describe('download tokens', () => {
  it('round-trips and carries no secret', async () => {
    const t = await mintToken(SECRET, { s: 'cs_live_abc', p: 'once', e: NOW + 60 })
    expect(t.startsWith('v1.')).toBe(true)
    expect(await verifyToken(SECRET, t, NOW)).toEqual({ s: 'cs_live_abc', p: 'once', e: NOW + 60 })
    expect(t).not.toContain('@')
    expect(t.length).toBeLessThan(200)
  })
  it('expires', async () => {
    const t = await mintToken(SECRET, { s: 'cs_live_abc', p: 'monthly', e: NOW + 60 })
    expect(await verifyToken(SECRET, t, NOW + 60)).toBeNull()
    expect(await verifyToken(SECRET, t, NOW + 61)).toBeNull()
  })
  it('a changed claim, a changed signature or another key is refused', async () => {
    const t = await mintToken(SECRET, { s: 'cs_live_abc', p: 'once', e: NOW + 60 })
    const [v, body, sig] = t.split('.')
    const other = b64url(new TextEncoder().encode(JSON.stringify({ s: 'cs_live_abc', p: 'once', e: NOW + 10 ** 9 })))
    expect(await verifyToken(SECRET, `${v}.${other}.${sig}`, NOW)).toBeNull()
    expect(await verifyToken(SECRET, `${v}.${body}.${sig.slice(0, -2)}AA`, NOW)).toBeNull()
    expect(await verifyToken('another-secret-with-plenty-of-bytes-xxxxxxxxx', t, NOW)).toBeNull()
    expect(await verifyToken(SECRET, `v2.${body}.${sig}`, NOW)).toBeNull()
  })
  it('garbage never throws', async () => {
    for (const g of [null, 1, '', 'v1', 'v1..', 'v1.%%%.###', 'a'.repeat(600), 'v1.' + b64url(new TextEncoder().encode('[1]')) + '.AAAA'])
      expect(await verifyToken(SECRET, g, NOW)).toBeNull()
  })
  it('base64url helpers', () => {
    const bytes = new Uint8Array([0, 255, 62, 63, 250])
    expect(fromB64url(b64url(bytes))).toEqual(bytes)
    expect(b64url(bytes)).not.toMatch(/[+/=]/)
    expect(fromB64url('not base64!')).toBeNull()
  })
  it('timingSafeEqual', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 2]))).toBe(true)
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1, 3]))).toBe(false)
    expect(timingSafeEqual(new Uint8Array([1, 2]), new Uint8Array([1]))).toBe(false)
  })
  it('TOKEN_DAYS is long enough for a perpetual licence to feel perpetual', () => {
    expect(TOKEN_DAYS).toBeGreaterThanOrEqual(365)
  })
})

describe('emails', () => {
  it('normalises', () => {
    expect(normalizeEmail('  Buyer@Example.COM ')).toBe('buyer@example.com')
    expect(normalizeEmail('nope')).toBeNull()
    expect(normalizeEmail('a@b')).toBeNull()
    expect(normalizeEmail(42)).toBeNull()
    expect(normalizeEmail('x'.repeat(250) + '@a.io')).toBeNull()
  })
  it('hashes with the key, never the address itself', async () => {
    const h = await hashEmail(SECRET, 'buyer@example.com')
    expect(h).toMatch(/^[0-9a-f]{64}$/)
    expect(h).not.toContain('buyer')
    expect(await hashEmail(SECRET, 'buyer@example.com')).toBe(h)
    expect(await hashEmail('other-secret-with-plenty-of-bytes-xxxxxxxxxxxx', 'buyer@example.com')).not.toBe(h)
  })
})

describe('Stripe webhook signatures', () => {
  const secret = 'whsec_abcdefghijklmnopqrstuvwxyz'
  const body = '{"id":"evt_1","type":"checkout.session.completed"}'
  async function sig(t: number, s = secret) {
    const { hmac } = await import('../src/token')
    return Array.from(await hmac(s, `${t}.${body}`), (b) => b.toString(16).padStart(2, '0')).join('')
  }
  it('accepts a fresh, correct signature (and one of several v1 values)', async () => {
    const s = await sig(NOW)
    expect(await verifyStripeSignature(secret, `t=${NOW},v1=${s}`, body, NOW + 100)).toBe(true)
    expect(await verifyStripeSignature(secret, `t=${NOW},v1=${'0'.repeat(64)},v1=${s}`, body, NOW)).toBe(true)
  })
  it('refuses a stale timestamp, a wrong secret, a changed body, or no header', async () => {
    const s = await sig(NOW)
    expect(await verifyStripeSignature(secret, `t=${NOW},v1=${s}`, body, NOW + 301)).toBe(false)
    expect(await verifyStripeSignature('whsec_other_secret_xxxxxxxxxxxxxxx', `t=${NOW},v1=${s}`, body, NOW)).toBe(false)
    expect(await verifyStripeSignature(secret, `t=${NOW},v1=${s}`, body + ' ', NOW)).toBe(false)
    expect(await verifyStripeSignature(secret, null, body, NOW)).toBe(false)
    expect(await verifyStripeSignature(secret, `t=${NOW}`, body, NOW)).toBe(false)
    expect(await verifyStripeSignature(secret, `v1=${s}`, body, NOW)).toBe(false)
    expect(await verifyStripeSignature('', `t=${NOW},v1=${s}`, body, NOW)).toBe(false)
  })
})

describe('manifest', () => {
  const good = { version: '0.1.3', files: { win: { name: 'Reel-Studio-Setup-0.1.3-x64.exe', key: 'v0.1.3/x.exe', size: 10, sha256: 'ab' } } }
  it('accepts a good one and strips what the app must not see', () => {
    const m = parseManifest(good)!
    expect(m.version).toBe('0.1.3')
    const pub = publicLatest(m, 'https://getreelstudio.com/update.html')
    expect(pub).toEqual({ version: '0.1.3', url: 'https://getreelstudio.com/update.html', files: { win: { name: 'Reel-Studio-Setup-0.1.3-x64.exe', size: 10, sha256: 'ab' }, mac: undefined } })
    expect(JSON.stringify(pub)).not.toContain('v0.1.3/')
  })
  it('refuses a bad version, a file name with a path, or no files', () => {
    expect(parseManifest({ ...good, version: 'v0.1.3' })).toBeNull()
    expect(parseManifest({ ...good, files: { win: { ...good.files.win, name: '../x.exe' } } })).toBeNull()
    expect(parseManifest({ version: '0.1.3', files: {} })).toBeNull()
    expect(parseManifest(null)).toBeNull()
    expect(parseManifest('x')).toBeNull()
  })
})
