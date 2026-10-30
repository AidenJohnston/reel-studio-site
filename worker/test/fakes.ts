// In-memory stand-ins for the bindings the Worker uses (the subset it uses), plus a fake Stripe.
import type { Env } from '../src/app'
import { hmac } from '../src/token'

export class FakeKV {
  store = new Map<string, string>()
  async get(key: string): Promise<string | null> {
    return this.store.get(key) ?? null
  }
  async put(key: string, value: string): Promise<void> {
    this.store.set(key, value)
  }
  async delete(key: string): Promise<void> {
    this.store.delete(key)
  }
}

function parseRange(h: string | null, size: number): { offset: number; length: number } | null {
  if (!h) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim())
  if (!m) return null
  if (m[1] === '' && m[2] !== '') {
    const suffix = Number(m[2])
    return { offset: Math.max(0, size - suffix), length: Math.min(size, suffix) }
  }
  const start = Number(m[1])
  const end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]))
  if (start > end) return null
  return { offset: start, length: end - start + 1 }
}

export class FakeR2 {
  objects = new Map<string, Uint8Array>()
  multipart = new Map<string, { key: string; parts: Map<number, Uint8Array>; aborted?: boolean }>()
  async head(key: string) {
    const b = this.objects.get(key)
    return b ? { key, size: b.length, httpEtag: `"etag-${key}"` } : null
  }
  async list(_opts?: { cursor?: string; limit?: number }) {
    const objects = [...this.objects.entries()].map(([key, b]) => ({ key, size: b.length, httpEtag: `"etag-${key}"`, uploaded: new Date(0) }))
    return { objects, truncated: false, cursor: undefined }
  }
  async delete(key: string) {
    this.objects.delete(key)
  }
  async createMultipartUpload(key: string) {
    const uploadId = `mpu-${this.multipart.size + 1}`
    this.multipart.set(uploadId, { key, parts: new Map() })
    return { key, uploadId }
  }
  resumeMultipartUpload(key: string, uploadId: string) {
    const r2 = this
    return {
      key,
      uploadId,
      async uploadPart(partNumber: number, value: ArrayBuffer | Uint8Array) {
        const mp = r2.multipart.get(uploadId)
        if (!mp || mp.key !== key) throw new Error('no such upload')
        mp.parts.set(partNumber, value instanceof Uint8Array ? value : new Uint8Array(value))
        return { partNumber, etag: `"p${partNumber}"` }
      },
      async complete(parts: { partNumber: number; etag: string }[]) {
        const mp = r2.multipart.get(uploadId)
        if (!mp || mp.key !== key) throw new Error('no such upload')
        const chunks = parts.map((p) => {
          const c = mp.parts.get(p.partNumber)
          if (!c || `"p${p.partNumber}"` !== p.etag) throw new Error('bad part')
          return c
        })
        const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0))
        let o = 0
        for (const c of chunks) (all.set(c, o), (o += c.length))
        r2.objects.set(key, all)
        r2.multipart.delete(uploadId)
        return { key, size: all.length, httpEtag: `"etag-${key}"` }
      },
      async abort() {
        const mp = r2.multipart.get(uploadId)
        if (mp) mp.aborted = true
      }
    }
  }
  async get(key: string, opts?: { range?: Headers; onlyIf?: Headers }) {
    const b = this.objects.get(key)
    if (!b) return null
    const etag = `"etag-${key}"`
    const inm = opts?.onlyIf?.get('if-none-match')
    if (inm && inm === etag) return { key, size: b.length, httpEtag: etag, body: null }
    const range = parseRange(opts?.range?.get('range') ?? null, b.length)
    const slice = range ? b.slice(range.offset, range.offset + range.length) : b
    return { key, size: b.length, httpEtag: etag, range: range ?? undefined, body: new Blob([slice]).stream() }
  }
}

export const SECRET = 'test-token-secret-with-plenty-of-bytes-0123456789'
export const WHSEC = 'test-webhook-signing-secret-with-plenty-of-bytes-0123456789'
export const STRIPE_KEY = 'rk_test_1234567890abcdefghijklmnop'

export const MANIFEST = {
  version: '0.1.2',
  page: 'https://getreelstudio.com/update.html',
  files: {
    win: { name: 'Reel-Studio-Setup-0.1.2-x64.exe', key: 'v0.1.2/Reel-Studio-Setup-0.1.2-x64.exe', size: 5, sha256: 'a'.repeat(64) },
    mac: { name: 'Reel-Studio-0.1.2-arm64.dmg', key: 'v0.1.2/Reel-Studio-0.1.2-arm64.dmg', size: 3, sha256: 'b'.repeat(64) }
  }
}

export const T0 = Date.UTC(2026, 9, 30, 12)
export const SID = 'cs_live_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0'

export function paidSession(over: Record<string, unknown> = {}) {
  return { id: SID, object: 'checkout.session', status: 'complete', payment_status: 'paid', mode: 'payment', customer: 'cus_123', customer_details: { email: 'Buyer@Example.com ' }, created: 1761800000, ...over }
}

export interface World {
  env: Env
  kv: FakeKV
  r2: FakeR2
  stripeCalls: string[]
  stripeReply: () => Promise<Response>
  emails: unknown[]
  waited: Promise<unknown>[]
  ctx: ExecutionContext
  now: number
}

export const ADMIN = 'admin-secret-with-at-least-thirty-two-bytes-0123456789'

export function world(opts: { manifest?: unknown; secrets?: boolean; email?: boolean; admin?: boolean; stripe?: () => Promise<Response> } = {}): World {
  const kv = new FakeKV()
  const r2 = new FakeR2()
  const manifest = 'manifest' in opts ? opts.manifest : MANIFEST
  if (manifest !== null) kv.store.set('manifest', JSON.stringify(manifest))
  r2.objects.set(MANIFEST.files.win.key, new Uint8Array([1, 2, 3, 4, 5]))
  r2.objects.set(MANIFEST.files.mac.key, new Uint8Array([9, 8, 7]))
  const emails: unknown[] = []
  const w: World = {
    kv,
    r2,
    stripeCalls: [],
    stripeReply: opts.stripe ?? (async () => new Response(JSON.stringify(paidSession()), { status: 200 })),
    emails,
    waited: [],
    now: T0,
    ctx: { waitUntil: (p: Promise<unknown>) => w.waited.push(p), passThroughOnException: () => {}, props: {} } as unknown as ExecutionContext,
    env: {
      PURCHASES: kv as unknown as KVNamespace,
      INSTALLERS: r2 as unknown as R2Bucket,
      SITE_ORIGIN: 'https://getreelstudio.com',
      FROM_EMAIL: 'support@getreelstudio.com',
      FROM_NAME: 'Reel Studio',
      ...(opts.secrets === false ? {} : { TOKEN_SECRET: SECRET, STRIPE_SECRET_KEY: STRIPE_KEY, STRIPE_WEBHOOK_SECRET: WHSEC }),
      ...(opts.admin ? { ADMIN_SECRET: ADMIN } : {}),
      ...(opts.email ? { EMAIL: { send: async (m: unknown) => (emails.push(m), { messageId: 'id-1' }) } as unknown as SendEmail } : {})
    }
  }
  return w
}

export function deps(w: World) {
  return {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url
      w.stripeCalls.push(`${init?.method ?? 'GET'} ${url} auth=${(init?.headers as Record<string, string>)?.Authorization ?? ''}`)
      return w.stripeReply()
    }) as typeof fetch,
    now: () => w.now
  }
}

export function req(path: string, init: RequestInit & { ip?: string } = {}): Request {
  const h = new Headers(init.headers)
  h.set('cf-connecting-ip', init.ip ?? '203.0.113.7')
  return new Request(`https://dl.getreelstudio.com${path}`, { ...init, headers: h })
}

/** A Stripe-signed webhook request. */
export async function signed(body: string, tSec: number, secret = WHSEC): Promise<Request> {
  const sig = Array.from(await hmac(secret, `${tSec}.${body}`), (b) => b.toString(16).padStart(2, '0')).join('')
  return req('/stripe/webhook', { method: 'POST', body, headers: { 'stripe-signature': `t=${tSec},v1=${sig}`, 'content-type': 'application/json' } })
}
