// Random ids and tokens, hashes, and the encryption of what we keep from Google.
//
// Tokens at rest: AES-256-GCM under ENC_KEY (a Worker secret, base64url of 32 random bytes), stored as
// `k1.<iv>.<ciphertext+tag>`, both base64url. The associated data names the row the value belongs to
// (`conn:<id>` for a refresh token, `conn:<id>:access` for an access token, `upload:<id>` for an upload's session
// address), so a value copied into another row fails to decrypt.
// The .ts extension lets tools/seed-connection.mjs run this file under plain Node (type stripping).
import { b64url, fromB64url, timingSafeEqual } from '../../worker/src/token.ts'

const enc = new TextEncoder()
const dec = new TextDecoder()

export function randomBytes(n: number): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(n))
}

/** base64url of n random bytes (32 bytes = 43 characters). */
export function randomToken(n = 32): string {
  return b64url(randomBytes(n))
}

export function hex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')
}

/** `<prefix>_` + 32 hex: the ids of sessions (s), attempts (a), connections (c) and uploads (u). */
export function newId(prefix: 's' | 'a' | 'c' | 'u'): string {
  return `${prefix}_${hex(randomBytes(16))}`
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', enc.encode(text)))
}

/** Hex SHA-256: how session tokens, begin tokens and the OAuth cookie are stored. */
export async function sha256hex(text: string): Promise<string> {
  return hex(await sha256(text))
}

/** Constant-time comparison of two hex hashes. */
export function sameHash(a: string | null | undefined, b: string): boolean {
  if (!a) return false
  return timingSafeEqual(enc.encode(a), enc.encode(b))
}

/** PKCE S256: base64url(SHA-256(verifier)). */
export async function pkceChallenge(verifier: string): Promise<string> {
  return b64url(await sha256(verifier))
}

/** The AES-GCM key from ENC_KEY, or null if it is missing or not 32 bytes. */
export async function importEncKey(secret: string | undefined): Promise<CryptoKey | null> {
  if (!secret) return null
  const raw = fromB64url(secret.trim())
  if (!raw || raw.length !== 32) return null
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function encrypt(key: CryptoKey, plain: string, ad: string): Promise<string> {
  const iv = randomBytes(12)
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(ad) }, key, enc.encode(plain))
  return `k1.${b64url(iv)}.${b64url(ct)}`
}

/** Throws if the value was not made by encrypt() under this key for this associated data. */
export async function decrypt(key: CryptoKey, stored: string, ad: string): Promise<string> {
  const [v, ivText, ctText] = stored.split('.')
  const iv = ivText ? fromB64url(ivText) : null
  const ct = ctText ? fromB64url(ctText) : null
  if (v !== 'k1' || !iv || iv.length !== 12 || !ct) throw new Error('not an encrypted value')
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv, additionalData: enc.encode(ad) }, key, ct)
  return dec.decode(plain)
}

export const ad = {
  refresh: (connectionId: string) => `conn:${connectionId}`,
  access: (connectionId: string) => `conn:${connectionId}:access`,
  upload: (uploadId: string) => `upload:${uploadId}`
}
