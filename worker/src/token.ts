// Download tokens: `v1.<claims>.<signature>`, both parts base64url. The claims name the Stripe Checkout
// Session the buyer paid in, the plan, and an expiry. The signature is HMAC-SHA256 under TOKEN_SECRET, so a
// token cannot be forged or edited, and nothing in it is a secret (no email, no name). The same key, with
// a different prefix, hashes buyer emails so the records never hold an address in the clear.
export type Plan = 'once' | 'monthly'

export interface TokenClaims {
  /** Stripe Checkout Session id (cs_live_…). */
  s: string
  p: Plan
  /** Expiry, seconds since 1970. */
  e: number
}

/** How long a download link works. The $99 license is perpetual, so a long life; the thanks page and the
 * email form can always mint a fresh one from the same purchase. */
export const TOKEN_DAYS = 400
const MAX_TOKEN_LENGTH = 512

const enc = new TextEncoder()

export function b64url(bytes: ArrayBuffer | Uint8Array): string {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let s = ''
  for (const b of u8) s += String.fromCharCode(b)
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromB64url(s: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]*$/.test(s)) return null
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4)
  try {
    const bin = atob(b64)
    const out = new Uint8Array(bin.length)
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
    return out
  } catch {
    return null
  }
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
}

export async function hmac(secret: string, data: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.sign('HMAC', await key(secret), enc.encode(data)))
}

/** Constant-time comparison (same length required). */
export function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  return diff === 0
}

export async function mintToken(secret: string, claims: TokenClaims): Promise<string> {
  const body = b64url(enc.encode(JSON.stringify({ s: claims.s, p: claims.p, e: claims.e })))
  const sig = b64url(await hmac(secret, `v1.${body}`))
  return `v1.${body}.${sig}`
}

/** The claims if the token is well-formed, signed by us and not expired; otherwise null. */
export async function verifyToken(secret: string, token: unknown, nowSec: number): Promise<TokenClaims | null> {
  if (typeof token !== 'string' || token.length > MAX_TOKEN_LENGTH) return null
  const parts = token.split('.')
  if (parts.length !== 3 || parts[0] !== 'v1') return null
  const [, body, sig] = parts
  const given = fromB64url(sig)
  if (!given) return null
  const expected = await hmac(secret, `v1.${body}`)
  if (!timingSafeEqual(given, expected)) return null
  const raw = fromB64url(body)
  if (!raw) return null
  let claims: unknown
  try {
    claims = JSON.parse(new TextDecoder().decode(raw))
  } catch {
    return null
  }
  if (!claims || typeof claims !== 'object') return null
  const { s, p, e } = claims as Record<string, unknown>
  if (typeof s !== 'string' || !s || (p !== 'once' && p !== 'monthly') || typeof e !== 'number' || !Number.isFinite(e)) return null
  if (e <= nowSec) return null
  return { s, p, e }
}

/** Lower-cased, trimmed, or null if it does not look like an address at all. */
export function normalizeEmail(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const e = input.trim().toLowerCase()
  if (e.length < 3 || e.length > 254) return null
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)) return null
  return e
}

/** Keyed hash of a normalised email (hex). The records index buyers by this, never by the address. */
export async function hashEmail(secret: string, email: string): Promise<string> {
  const bytes = await hmac(secret, `email:${email}`)
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}
