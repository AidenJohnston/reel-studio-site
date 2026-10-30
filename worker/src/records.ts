// Purchase records in KV. Two keys per purchase: `sess:<session id>` holds the record; `email:<keyed hash>`
// points at the newest session for that buyer, so "email me my link" can find it. No address, no name.
import type { Plan } from './token'

export interface Purchase {
  sid: string
  plan: Plan
  /** hashEmail() of the buyer's address, or null if Stripe gave none. */
  emailHash: string | null
  customer: string | null
  /** Stripe's `created` (seconds). */
  created: number
  /** When we wrote it (ms). */
  recordedAt: number
  source: 'claim' | 'webhook'
}

export interface RecordStore {
  get(key: string, type: 'text'): Promise<string | null>
  put(key: string, value: string): Promise<void>
}

export async function getPurchase(kv: RecordStore, sid: string): Promise<Purchase | null> {
  const raw = await kv.get(`sess:${sid}`, 'text')
  if (!raw) return null
  try {
    const v = JSON.parse(raw)
    return v && typeof v === 'object' && typeof v.sid === 'string' ? (v as Purchase) : null
  } catch {
    return null
  }
}

/** Idempotent: a session already on file is not rewritten (the first record wins), but the email pointer
 * always moves to this session so the newest purchase is the one a link request finds. */
export async function recordPurchase(kv: RecordStore, p: Purchase): Promise<Purchase> {
  const existing = await getPurchase(kv, p.sid)
  if (!existing) await kv.put(`sess:${p.sid}`, JSON.stringify(p))
  if (p.emailHash) await kv.put(`email:${p.emailHash}`, p.sid)
  return existing ?? p
}

export async function findByEmailHash(kv: RecordStore, hash: string): Promise<Purchase | null> {
  const sid = await kv.get(`email:${hash}`, 'text')
  return sid ? getPurchase(kv, sid) : null
}
