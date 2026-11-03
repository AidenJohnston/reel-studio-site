// JSON answers and the errors every route throws. A route throws `fail(...)`; app.ts turns it into
// `{ "error": "<code>", ...extra }` with the status. Codes are the contract's (snake_case).
export class ApiError extends Error {
  status: number
  body: Record<string, unknown>
  headers: Record<string, string>
  constructor(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}) {
    super(code)
    this.status = status
    this.body = { error: code, ...extra }
    this.headers = headers
  }
}

export function fail(status: number, code: string, extra: Record<string, unknown> = {}, headers: Record<string, string> = {}): ApiError {
  return new ApiError(status, code, extra, headers)
}

/** 429 always carries Retry-After (seconds). */
export function tooMany(code: 'rate_limited' | 'quota' | 'upload_limit', retryAfterSec: number): ApiError {
  return fail(429, code, {}, { 'Retry-After': String(Math.max(1, Math.round(retryAfterSec))) })
}

export function badRequest(field?: 'title' | 'description' | 'privacy' | 'size' | 'device' | 'content_range'): ApiError {
  return fail(400, 'bad_request', field ? { field } : {})
}

export function notConfigured(what: 'token_secret' | 'enc_key' | 'google' | 'db'): ApiError {
  return fail(503, 'not_configured', { what })
}

/** Google 5xx or a network failure (retry: true), or an answer we didn't expect (retry: false). */
export function platformError(retry: boolean): ApiError {
  return fail(502, 'platform_error', { retry })
}

export function json(body: unknown, status = 200, extra: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra }
  })
}

export async function readJson(request: Request): Promise<Record<string, unknown>> {
  let body: unknown
  try {
    body = await request.json()
  } catch {
    throw badRequest()
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw badRequest()
  return body as Record<string, unknown>
}

export function bearer(request: Request): string {
  const auth = request.headers.get('authorization') ?? ''
  return auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
}

/** For log lines: enough of an id to find it, never a secret. */
export function short(id: string): string {
  return id.length > 14 ? id.slice(0, 10) + '…' + id.slice(-4) : id
}
