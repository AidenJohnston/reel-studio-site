// Soft per-IP limits on the two endpoints a stranger can poke (claim by session id, link by email). KV is
// eventually consistent, so this is a brake, not a wall; the ids and tokens themselves carry the security.
export interface CounterStore {
  get(key: string, type: 'text'): Promise<string | null>
  put(key: string, value: string, opts?: { expirationTtl?: number }): Promise<void>
}

export async function allow(kv: CounterStore, bucket: string, who: string, limit: number, windowSec: number, nowMs: number): Promise<boolean> {
  const slot = Math.floor(nowMs / 1000 / windowSec)
  const key = `rl:${bucket}:${slot}:${who}`
  const n = Number((await kv.get(key, 'text')) ?? '0')
  if (n >= limit) return false
  await kv.put(key, String(n + 1), { expirationTtl: Math.max(60, windowSec * 2) })
  return true
}

export function clientIp(request: Request): string {
  return request.headers.get('cf-connecting-ip') ?? request.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'unknown'
}
