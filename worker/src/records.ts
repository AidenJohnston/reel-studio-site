// Purchase records in KV. Two keys per purchase: `sess:<session id>` holds the record; `email:<keyed hash>`
// points at the newest session for that buyer, so "email me my link" can find it. No address, no name.
//
// What Stripe later says about a purchase lives under its own keys, written by the webhook whether or not
// the purchase is on file yet (Stripe does not promise any order between events):
//   `sub:<subscription id>`    {status, at}             a monthly plan's subscription status
//   `pay:<payment intent id>`  {refunded, dispute, at}  a one-time payment refunded or disputed
// `entitlement()` reads them: is this purchase still entitled to downloads and updates?
//
// Retention (hub decisions/2026-11-02-purchase-record-retention.md): a record is kept while its purchase is
// entitled. When it stops being entitled (subscription ended, refund, dispute), every key of that purchase gets a
// 90-day expiry; if it becomes entitled again (resubscribed card, dispute won) the expiry is lifted. The buyer can
// ask for deletion sooner (`forgetPurchase`, through /admin/purchase). `subsess:` and `paysess:` point from a
// subscription or payment back to its session, so a Stripe event can find the record to expire.
import type { Plan } from './token'

export interface Purchase {
  sid: string
  plan: Plan
  /** hashEmail() of the buyer's address, or null if Stripe gave none. */
  emailHash: string | null
  customer: string | null
  /** The Stripe subscription (monthly plan), when the session named one. */
  subscription?: string | null
  /** The Stripe PaymentIntent (one-time plan), when the session named one. */
  paymentIntent?: string | null
  /** Stripe's `created` (seconds). */
  created: number
  /** When we wrote it (ms). */
  recordedAt: number
  source: 'claim' | 'webhook'
  /** When the receipt email with the links went out (ms), if it did. */
  receiptAt?: number
}

export interface RecordStore {
  get(key: string, type: 'text'): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
  delete(key: string): Promise<void>
}

/** How long a record outlives its entitlement. */
export const RETENTION_DAYS = 90

async function getJson<T>(kv: RecordStore, key: string): Promise<T | null> {
  const raw = await kv.get(key, 'text')
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' ? (v as T) : null
  } catch {
    return null
  }
}

export async function getPurchase(kv: RecordStore, sid: string): Promise<Purchase | null> {
  const v = await getJson<Purchase>(kv, `sess:${sid}`)
  return v && typeof v.sid === 'string' ? v : null
}

/** Idempotent: a session already on file is not rewritten (the first record wins), but the email pointer
 * always moves to this session so the newest purchase is the one a link request finds. */
export async function recordPurchase(kv: RecordStore, p: Purchase): Promise<Purchase> {
  const existing = await getPurchase(kv, p.sid)
  if (!existing) await kv.put(`sess:${p.sid}`, JSON.stringify(p))
  if (p.emailHash) await kv.put(`email:${p.emailHash}`, p.sid)
  const rec = existing ?? p
  if (rec.subscription) await kv.put(`subsess:${rec.subscription}`, rec.sid)
  if (rec.paymentIntent) await kv.put(`paysess:${rec.paymentIntent}`, rec.sid)
  // Stripe may have said "canceled" or "refunded" before this record existed.
  await applyRetention(kv, rec.sid)
  return rec
}

export async function markReceipt(kv: RecordStore, p: Purchase, nowMs: number): Promise<void> {
  const current = (await getPurchase(kv, p.sid)) ?? p
  await kv.put(`sess:${p.sid}`, JSON.stringify({ ...current, receiptAt: nowMs }))
}

export async function findByEmailHash(kv: RecordStore, hash: string): Promise<Purchase | null> {
  const sid = await kv.get(`email:${hash}`, 'text')
  return sid ? getPurchase(kv, sid) : null
}

// ---- what Stripe says later ---------------------------------------------------------------------------

export const SUBSCRIPTION_ID_RE = /^sub_[A-Za-z0-9]{8,120}$/
export const PAYMENT_INTENT_ID_RE = /^pi_[A-Za-z0-9]{8,120}$/

/** A subscription in one of these still gets downloads and updates. `past_due`: Stripe is still retrying the
 * card. `incomplete`: Checkout creates the subscription in it and makes it active within the same second, and
 * two events in one second may arrive in either order; a purchase record exists only for a PAID session, so
 * an incomplete subscription with a record is one whose `active` event is late. `canceled`, `unpaid`,
 * `incomplete_expired` and `paused` do not. */
export const LIVE_SUBSCRIPTION_STATUSES = new Set(['active', 'trialing', 'past_due', 'incomplete'])

export interface SubscriptionState {
  status: string
  /** The Stripe event's `created` (seconds): an older event never overwrites a newer one. */
  at: number
}

export interface PaymentState {
  refunded?: boolean
  /** Stripe's dispute status: `needs_response`, `under_review`, `won`, `lost`, `warning_closed`, … */
  dispute?: string
  at: number
}

export async function getSubscriptionState(kv: RecordStore, id: string): Promise<SubscriptionState | null> {
  return getJson<SubscriptionState>(kv, `sub:${id}`)
}

export async function setSubscriptionState(kv: RecordStore, id: string, status: string, at: number): Promise<boolean> {
  const cur = await getSubscriptionState(kv, id)
  if (cur && cur.at > at) return false
  await kv.put(`sub:${id}`, JSON.stringify({ status, at }))
  return true
}

export async function getPaymentState(kv: RecordStore, id: string): Promise<PaymentState | null> {
  return getJson<PaymentState>(kv, `pay:${id}`)
}

/** Merge one fact into the payment's state. A refund never un-happens; a dispute status follows the newest event. */
export async function updatePaymentState(kv: RecordStore, id: string, change: { refunded?: true; dispute?: string }, at: number): Promise<void> {
  const cur = (await getPaymentState(kv, id)) ?? { at: 0 }
  const next: PaymentState = { ...cur, at: Math.max(cur.at, at) }
  if (change.refunded) next.refunded = true
  if (change.dispute && (!cur.dispute || at >= cur.at)) next.dispute = change.dispute
  await kv.put(`pay:${id}`, JSON.stringify(next))
}

/** Dispute statuses that leave the buyer entitled: closed in the seller's favour, or an inquiry that closed
 * without becoming a chargeback. */
const SETTLED_DISPUTES = new Set(['won', 'warning_closed'])

/** Give every key of this purchase a RETENTION_DAYS expiry if it is no longer entitled, or lift the expiry if it
 * is entitled (again). A KV put without an expiry makes the key permanent. Returns whether it now expires. */
export async function applyRetention(kv: RecordStore, sid: string): Promise<boolean> {
  const rec = await getPurchase(kv, sid)
  if (!rec) return false
  const expires = !(await entitlement(kv, rec)).ok
  const opts = expires ? { expirationTtl: RETENTION_DAYS * 86400 } : undefined
  const keep = async (key: string) => {
    const v = await kv.get(key, 'text')
    if (v !== null) await kv.put(key, v, opts)
  }
  await keep(`sess:${sid}`)
  // The email pointer only if it still points here (a newer purchase by the same buyer keeps it).
  if (rec.emailHash && (await kv.get(`email:${rec.emailHash}`, 'text')) === sid) await keep(`email:${rec.emailHash}`)
  if (rec.subscription) {
    await keep(`sub:${rec.subscription}`)
    await keep(`subsess:${rec.subscription}`)
  }
  if (rec.paymentIntent) {
    await keep(`pay:${rec.paymentIntent}`)
    await keep(`paysess:${rec.paymentIntent}`)
  }
  return expires
}

/** The session behind a subscription or a payment, if the purchase is on file. */
export async function sidFor(kv: RecordStore, ref: { subscription?: string; paymentIntent?: string }): Promise<string | null> {
  if (ref.subscription) return kv.get(`subsess:${ref.subscription}`, 'text')
  if (ref.paymentIntent) return kv.get(`paysess:${ref.paymentIntent}`, 'text')
  return null
}

/** Delete everything we hold about one purchase now (the buyer asked). Its links and updates stop working. */
export async function forgetPurchase(kv: RecordStore, sid: string): Promise<boolean> {
  const rec = await getPurchase(kv, sid)
  if (!rec) return false
  if (rec.emailHash && (await kv.get(`email:${rec.emailHash}`, 'text')) === sid) await kv.delete(`email:${rec.emailHash}`)
  if (rec.subscription) for (const k of [`sub:${rec.subscription}`, `subsess:${rec.subscription}`]) await kv.delete(k)
  if (rec.paymentIntent) for (const k of [`pay:${rec.paymentIntent}`, `paysess:${rec.paymentIntent}`]) await kv.delete(k)
  await kv.delete(`sess:${sid}`)
  return true
}

export type Entitlement = { ok: true } | { ok: false; reason: 'refunded' | 'disputed' | 'subscription ended' }

/** Is this purchase still entitled to downloads and updates?
 *  - one-time ($99, no longer sold): always, unless the payment was refunded or is disputed (or the dispute lost).
 *  - monthly: while the subscription is active, trialing or past due. No status on file yet means the paid
 *    session is all we know, so yes. */
export async function entitlement(kv: RecordStore, rec: Purchase): Promise<Entitlement> {
  if (rec.plan === 'once') {
    if (!rec.paymentIntent) return { ok: true }
    const pay = await getPaymentState(kv, rec.paymentIntent)
    if (pay?.refunded) return { ok: false, reason: 'refunded' }
    if (pay?.dispute && !SETTLED_DISPUTES.has(pay.dispute)) return { ok: false, reason: 'disputed' }
    return { ok: true }
  }
  if (!rec.subscription) return { ok: true }
  const sub = await getSubscriptionState(kv, rec.subscription)
  if (sub && !LIVE_SUBSCRIPTION_STATUSES.has(sub.status)) return { ok: false, reason: 'subscription ended' }
  return { ok: true }
}
