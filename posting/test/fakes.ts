// The world a test runs in: the purchases KV (read only: put and delete throw, so a test fails if the Worker
// ever writes there), D1 on node:sqlite, the fake Google, a clock, and helpers that play the app and the browser.
import type { Purchase } from '../../worker/src/records'
import { b64url, mintToken } from '../../worker/src/token'
import { handle, type Deps, type Env } from '../src/app'
import { FakeD1 } from './fake-d1'
import { createFakeGoogle, type FakeGoogle, type FakeGoogleOptions } from './fake-google'

export const SECRET = 'test-token-secret-with-plenty-of-bytes-0123456789'
export const ENC_KEY = b64url(new Uint8Array(32).map((_, i) => i * 7 + 1))
export const ORIGIN = 'https://post-staging.getreelstudio.com'
export const SITE = 'https://getreelstudio.com'
export const T0 = Date.UTC(2026, 10, 3, 12)
export const SID = 'cs_test_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8s9T0'
export const SUB = 'sub_1AbCdEfGhIjKlMnOp'
export const CALLBACK = '/v1/youtube/callback'

/** PURCHASES as the posting Worker must treat it: reads only. */
export class ReadOnlyKV {
  store = new Map<string, string>()
  reads = 0
  async get(key: string): Promise<string | null> {
    this.reads++
    return this.store.get(key) ?? null
  }
  async put(): Promise<void> {
    throw new Error('the posting Worker wrote to PURCHASES')
  }
  async delete(): Promise<void> {
    throw new Error('the posting Worker deleted from PURCHASES')
  }
}

export interface World {
  env: Env
  kv: ReadOnlyKV
  db: FakeD1
  google: FakeGoogle
  now: number
  cache?: NonNullable<Deps['entitlementCache']>
  deps(): Deps
}

export function world(opts: { google?: FakeGoogleOptions; env?: Partial<Env>; cache?: boolean; purchase?: Partial<Purchase> | null } = {}): World {
  const kv = new ReadOnlyKV()
  const db = new FakeD1()
  const google = createFakeGoogle(opts.google)
  const w: World = {
    kv,
    db,
    google,
    now: T0,
    cache: opts.cache ? new Map() : undefined,
    env: {
      PURCHASES: kv as unknown as KVNamespace,
      DB: db as unknown as D1Database,
      PUBLIC_ORIGIN: ORIGIN,
      SITE_ORIGIN: SITE,
      TOKEN_SECRET: SECRET,
      ENC_KEY,
      ...google.env,
      ...opts.env
    },
    deps: () => ({ fetch: google.fetch, now: () => w.now, ...(w.cache ? { entitlementCache: w.cache } : {}) })
  }
  google.state.now = () => w.now
  if (opts.purchase !== null) putPurchase(w, opts.purchase ?? {})
  return w
}

/** A purchase record, written straight into the store as the downloads Worker would have. */
export function putPurchase(w: World, over: Partial<Purchase> = {}): Purchase {
  const p: Purchase = { sid: SID, plan: 'monthly', emailHash: null, customer: 'cus_1', subscription: SUB, created: 1762000000, recordedAt: T0 - 86400_000, source: 'webhook', ...over }
  w.kv.store.set(`sess:${p.sid}`, JSON.stringify(p))
  return p
}

export function endSubscription(w: World, id = SUB): void {
  w.kv.store.set(`sub:${id}`, JSON.stringify({ status: 'canceled', at: 1762100000 }))
}

export function purchaseKey(over: { s?: string; p?: 'once' | 'monthly'; e?: number } = {}, secret = SECRET): Promise<string> {
  return mintToken(secret, { s: SID, p: 'monthly', e: Math.floor(T0 / 1000) + 86400, ...over })
}

export interface Call extends RequestInit {
  bearer?: string
  ip?: string
  cookie?: string
  json?: unknown
}

/** One request to the Worker, at path (or a full URL on our origin). */
export function run(w: World, path: string, init: Call = {}): Promise<Response> {
  const h = new Headers(init.headers)
  h.set('cf-connecting-ip', init.ip ?? '203.0.113.7')
  if (init.bearer) h.set('authorization', `Bearer ${init.bearer}`)
  if (init.cookie) h.set('cookie', init.cookie)
  let body = init.body
  if (init.json !== undefined) {
    body = JSON.stringify(init.json)
    h.set('content-type', 'application/json')
  }
  const url = path.startsWith('http') ? path : ORIGIN + path
  // A streamed body (no Content-Length, like chunked transfer) needs duplex in Node's Request.
  const stream = body instanceof ReadableStream ? { duplex: 'half' } : {}
  return handle(new Request(url, { method: init.method, headers: h, body, ...stream } as RequestInit), w.env, w.deps())
}

export async function body<T = Record<string, any>>(res: Response): Promise<T> {
  return (await res.json()) as T
}

/** Trade a purchase key for a session, as the app does on Sign in. */
export async function signIn(w: World, device = 'Windows'): Promise<string> {
  const res = await run(w, '/v1/sessions', { method: 'POST', bearer: await purchaseKey(), json: { device } })
  if (res.status !== 201) throw new Error(`sign in: ${res.status} ${await res.text()}`)
  return (await body<{ session: string }>(res)).session
}

export async function startAttempt(w: World, session: string): Promise<{ attemptId: string; openUrl: string }> {
  const res = await run(w, '/v1/connections/youtube/attempts', { method: 'POST', bearer: session })
  if (res.status !== 201) throw new Error(`attempt: ${res.status} ${await res.text()}`)
  return body(res)
}

export function cookieOf(res: Response): string {
  const set = res.headers.get('set-cookie') ?? ''
  return set.split(';')[0]
}

/** The browser: open the begin link, go through (fake) Google, come back to the callback with the cookie. */
export async function browse(w: World, openUrl: string, opts: { cookie?: string } = {}): Promise<{ begin: Response; google?: Response; callback?: Response; cookie: string }> {
  const begin = await run(w, openUrl)
  if (begin.status !== 302) return { begin, cookie: '' }
  const cookie = opts.cookie ?? cookieOf(begin)
  const google = await w.google.handle(new Request(begin.headers.get('location')!))
  if (google.status !== 302) return { begin, google, cookie }
  const back = google.headers.get('location')!
  const callback = await run(w, back, { cookie })
  return { begin, google, callback, cookie }
}

/** Sign in and connect YouTube end to end. */
export async function connected(w: World): Promise<{ session: string; attemptId: string }> {
  const session = await signIn(w)
  const { attemptId, openUrl } = await startAttempt(w, session)
  const r = await browse(w, openUrl)
  if (r.callback?.status !== 200) throw new Error(`connect: ${r.callback?.status} ${await r.callback?.text()}`)
  return { session, attemptId }
}

/** Bytes 0..n-1 with a recognisable pattern. */
export function video(n: number): Uint8Array {
  const b = new Uint8Array(n)
  for (let i = 0; i < n; i++) b[i] = (i * 31 + (i >> 8)) & 0xff
  return b
}

export const META = { platform: 'youtube', mimeType: 'video/mp4', title: 'How I got my first job', description: 'A short one.', privacy: 'private', madeForKids: false }

export async function startUpload(w: World, session: string, size: number, over: Record<string, unknown> = {}): Promise<Response> {
  return run(w, '/v1/uploads', { method: 'POST', bearer: session, json: { ...META, size, ...over } })
}

export function putChunk(w: World, session: string, uploadId: string, bytes: Uint8Array, first: number, size: number): Promise<Response> {
  const last = first + bytes.length - 1
  return run(w, `/v1/uploads/${uploadId}`, {
    method: 'PUT',
    bearer: session,
    headers: { 'content-type': 'application/octet-stream', 'content-range': `bytes ${first}-${last}/${size}` },
    body: bytes
  })
}
