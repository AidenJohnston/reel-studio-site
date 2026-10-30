// The two things we need from Stripe: verifying a webhook's signature, and reading one Checkout Session
// (restricted key, read-only) to confirm it was paid. No SDK: two small, auditable requests.
import { hmac, timingSafeEqual } from './token'
import type { Plan } from './token'

export const STRIPE_API = 'https://api.stripe.com/v1'
export const SIGNATURE_TOLERANCE_SEC = 300
export const SESSION_ID_RE = /^cs_(live|test)_[A-Za-z0-9]{8,120}$/

/** `Stripe-Signature: t=<unix>,v1=<hex>[,v1=<hex>]`: HMAC-SHA256 of `<t>.<body>` under the endpoint secret. */
export async function verifyStripeSignature(secret: string, header: string | null, body: string, nowSec: number): Promise<boolean> {
  if (!header || !secret) return false
  let t: number | null = null
  const sigs: string[] = []
  for (const part of header.split(',')) {
    const i = part.indexOf('=')
    if (i < 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k === 't') t = Number(v)
    else if (k === 'v1') sigs.push(v)
  }
  if (t === null || !Number.isFinite(t) || sigs.length === 0) return false
  if (Math.abs(nowSec - t) > SIGNATURE_TOLERANCE_SEC) return false
  const expected = await hmac(secret, `${t}.${body}`)
  for (const s of sigs) {
    if (!/^[0-9a-f]{64}$/i.test(s)) continue
    const given = new Uint8Array(s.match(/../g)!.map((h) => parseInt(h, 16)))
    if (timingSafeEqual(given, expected)) return true
  }
  return false
}

export interface StripeSession {
  id: string
  object?: string
  status?: string
  payment_status?: string
  mode?: string
  customer?: string | null
  customer_details?: { email?: string | null } | null
  customer_email?: string | null
  payment_link?: string | null
  created?: number
}

export type SessionResult = { kind: 'ok'; session: StripeSession } | { kind: 'missing' } | { kind: 'error'; status: number }

/** One GET of a Checkout Session. `missing` for 404 (unknown id, or an id from another account). */
export async function fetchSession(fetchFn: typeof fetch, key: string, id: string): Promise<SessionResult> {
  let res: Response
  try {
    res = await fetchFn(`${STRIPE_API}/checkout/sessions/${encodeURIComponent(id)}`, {
      method: 'GET',
      headers: { Authorization: `Bearer ${key}` }
    })
  } catch {
    return { kind: 'error', status: 0 }
  }
  if (res.status === 404) return { kind: 'missing' }
  if (!res.ok) return { kind: 'error', status: res.status }
  let session: StripeSession
  try {
    session = (await res.json()) as StripeSession
  } catch {
    return { kind: 'error', status: 502 }
  }
  if (!session || typeof session !== 'object' || session.id !== id) return { kind: 'error', status: 502 }
  return { kind: 'ok', session }
}

export function sessionIsPaid(s: StripeSession): boolean {
  return s.status === 'complete' && s.payment_status === 'paid'
}

export function sessionPlan(s: StripeSession): Plan {
  return s.mode === 'subscription' ? 'monthly' : 'once'
}

export function sessionEmail(s: StripeSession): string | null {
  return s.customer_details?.email ?? s.customer_email ?? null
}
