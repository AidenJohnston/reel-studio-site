// Support reports from the app's "Report a problem" form, and what the internal dashboard reads.
//
//   POST /v1/support   multipart/form-data, answered 201 {ok, id}. Fields (every one capped, see FIELD_CAPS):
//     what         required  what happened
//     expected     optional  what they expected instead
//     email        optional  where to answer them (stored as typed, so someone can reply)
//     diagnostics  optional  the text of the app's "Copy diagnostics"
//     appVersion   required  e.g. 0.1.6
//     os           required  e.g. "Windows 10.0.26200 x64"
//     screenshot   optional  file, PNG or JPEG, at most MAX_SCREENSHOT bytes
//   Authorization: Bearer <download token>, when the app has a key. It tells us whose report it is (the
//   purchase it belongs to, its plan, whether it is still entitled). A report without one, or with a key that
//   does not verify, is still taken: a broken install is exactly when someone writes in.
//
// Storage, in the PURCHASES KV (no new binding):
//   support:r:<ref>     the report (JSON), with list metadata (id, time, status, first line) so the dashboard
//                       lists reports without reading each one
//   support:shot:<ref>  the screenshot bytes, when there is one
// <ref> is `<13 digits: 10^13 minus the ms time>-<id>`: KV lists keys in ascending order, so that is newest
// first. Both keys expire RETENTION_DAYS after the report came in (status changes keep the same expiry); the
// dashboard can delete one sooner.
//
// No public route reads any of this. The dashboard (support-admin.ts) needs the admin secret.
import { supportNotice } from './email'
import { allow, clientIp } from './ratelimit'
import { entitlement, getPurchase } from './records'
import { verifyToken, type Plan } from './token'

export const REPORT_PREFIX = 'support:r:'
export const SHOT_PREFIX = 'support:shot:'
export const RETENTION_DAYS = 180

/** Per IP and per purchase key. KV counters are a brake, not a wall (see ratelimit.ts). */
export const SUPPORT_IP_LIMIT = { n: 10, windowSec: 3600 }
export const SUPPORT_KEY_LIMIT = { n: 10, windowSec: 3600 }
/** Notices emailed to support per day, all reports together, so a flood cannot use up the month's sending.
 * Reports past it are still stored; the dashboard shows them. */
export const NOTICE_DAY_LIMIT = { n: 100, windowSec: 86400 }

export const MAX_SCREENSHOT = 2 * 1024 * 1024
/** The whole request: the screenshot, the text fields (diagnostics can be 200,000 characters, some of them several bytes) and the multipart framing. */
export const MAX_BODY = MAX_SCREENSHOT + 1024 * 1024

/** Characters, after trimming. */
export const FIELD_CAPS = { what: 5000, expected: 3000, email: 254, diagnostics: 200_000, appVersion: 40, os: 120, note: 2000, fixedIn: 40 } as const

export const STATUSES = ['new', 'triaged', 'fixed', 'wontfix'] as const
export type Status = (typeof STATUSES)[number]

export const ID_RE = /^RS-[0-9A-HJKMNP-TV-Z]{8}$/
export const REF_RE = /^\d{13}-RS-[0-9A-HJKMNP-TV-Z]{8}$/
const VERSION_RE = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/

export interface KeyInfo {
  /** none: no key sent; invalid: a key we did not sign (or no TOKEN_SECRET to check it); valid: ours. */
  status: 'none' | 'invalid' | 'valid'
  /** The Checkout Session behind the key (`node tools/publish.mjs purchase --sid …` shows the purchase). */
  sid?: string
  plan?: Plan
  /** Whether that purchase is on file and still entitled to updates. */
  onFile?: boolean
  entitled?: boolean
  reason?: string
}

export interface SupportReport {
  id: string
  ref: string
  /** ms */
  created: number
  /** seconds since 1970, when KV deletes it */
  expires: number
  status: Status
  /** The version a fix shipped in, when status is fixed. */
  fixedIn: string | null
  /** Internal note; never shown to the reporter. */
  note: string
  updatedAt: number | null
  what: string
  expected: string
  email: string | null
  diagnostics: string
  appVersion: string
  os: string
  screenshot: { type: 'image/png' | 'image/jpeg'; size: number } | null
  key: KeyInfo
  /** Whether the notice email went out. */
  noticed: boolean
}

/** What KV keeps next to the key, for the list (KV allows 1024 bytes). */
export interface ReportMeta {
  id: string
  created: number
  status: Status
  fixedIn: string | null
  first: string
  appVersion: string
  os: string
  shot: boolean
  plan: Plan | null
  email: boolean
}

export interface SupportEnv {
  PURCHASES: KVNamespace
  EMAIL?: SendEmail
  FROM_EMAIL: string
  FROM_NAME: string
  TOKEN_SECRET?: string
}

function json(body: unknown, status: number): Response {
  // No CORS header: the app posts from its main process, and no page should be able to read the answer.
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

export function newId(): string {
  const b = crypto.getRandomValues(new Uint8Array(8))
  return 'RS-' + Array.from(b, (x) => CROCKFORD[x & 31]).join('')
}

export function refFor(createdMs: number, id: string): string {
  return String(1e13 - createdMs).padStart(13, '0') + '-' + id
}

/** Trimmed text with control characters other than newline and tab removed, CRLF as LF. */
export function cleanText(v: unknown): string {
  if (typeof v !== 'string') return ''
  return v
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000B-\u001F\u007F​-‏‪-‮⁦-⁩]/g, '')
    .trim()
}

/** One line: no newlines or tabs at all (for the OS, the version, list metadata, an email subject). */
export function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}

/** The first `n` characters of the first non-empty line. */
export function firstLine(s: string, n = 80): string {
  const line = s.split('\n').find((l) => l.trim()) ?? ''
  const t = oneLine(line)
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

/** PNG or JPEG by their first bytes, or null. The declared type is not trusted. */
export function imageType(b: Uint8Array): 'image/png' | 'image/jpeg' | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return 'image/png'
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return 'image/jpeg'
  return null
}

/** The body, or null when it is (or turns out to be) larger than `max`. Never buffers more than max + one chunk. */
async function readCapped(request: Request, max: number): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get('content-length') ?? 'NaN')
  if (Number.isFinite(declared) && declared > max) return null
  if (!request.body) return new Uint8Array()
  const reader = request.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    total += value.byteLength
    if (total > max) {
      await reader.cancel().catch(() => {})
      return null
    }
    chunks.push(value)
  }
  const out = new Uint8Array(total)
  let o = 0
  for (const c of chunks) (out.set(c, o), (o += c.byteLength))
  return out
}

/** Who the key belongs to. Never throws and never refuses: an unknown key is just `invalid`. */
async function keyInfo(request: Request, env: SupportEnv, nowMs: number): Promise<KeyInfo> {
  const auth = request.headers.get('authorization') ?? ''
  const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : ''
  if (!token) return { status: 'none' }
  const secret = env.TOKEN_SECRET
  if (typeof secret !== 'string' || secret.length < 16) return { status: 'invalid' }
  const c = await verifyToken(secret, token, Math.floor(nowMs / 1000), { ignoreExpiry: true })
  if (!c) return { status: 'invalid' }
  const rec = await getPurchase(env.PURCHASES, c.s)
  if (!rec) return { status: 'valid', sid: c.s, plan: c.p, onFile: false }
  const ent = await entitlement(env.PURCHASES, rec)
  return { status: 'valid', sid: rec.sid, plan: rec.plan, onFile: true, entitled: ent.ok, ...(ent.ok ? {} : { reason: ent.reason }) }
}

type Parsed = { ok: true; fields: Omit<SupportReport, 'id' | 'ref' | 'created' | 'expires' | 'status' | 'fixedIn' | 'note' | 'updatedAt' | 'key' | 'noticed' | 'screenshot'>; shot: Uint8Array | null; shotType: 'image/png' | 'image/jpeg' | null } | { ok: false; status: number; error: string; field?: string }

async function parseReport(form: FormData): Promise<Parsed> {
  const text = (name: keyof typeof FIELD_CAPS, required: boolean): string | { error: string; field: string } => {
    const raw = form.get(name)
    if (raw !== null && typeof raw !== 'string') return { error: 'must be text', field: name }
    const v = cleanText(raw)
    if (required && !v) return { error: 'required', field: name }
    if (v.length > FIELD_CAPS[name]) return { error: `longer than ${FIELD_CAPS[name]} characters`, field: name }
    return v
  }
  const what = text('what', true)
  const expected = text('expected', false)
  const emailRaw = text('email', false)
  const diagnostics = text('diagnostics', false)
  const appVersion = text('appVersion', true)
  const os = text('os', true)
  for (const v of [what, expected, emailRaw, diagnostics, appVersion, os]) if (typeof v !== 'string') return { ok: false, status: 400, ...v }
  let email: string | null = null
  if (emailRaw) {
    const e = (emailRaw as string).toLowerCase()
    if (!/^[^\s@<>",;]+@[^\s@<>",;]+\.[^\s@<>",;]+$/.test(e)) return { ok: false, status: 400, error: 'not an email address', field: 'email' }
    email = e
  }
  if (!VERSION_RE.test(appVersion as string)) return { ok: false, status: 400, error: 'not a version', field: 'appVersion' }

  let shot: Uint8Array | null = null
  let shotType: 'image/png' | 'image/jpeg' | null = null
  const file = form.get('screenshot')
  if (file !== null && typeof file !== 'string') {
    if (file.size > MAX_SCREENSHOT) return { ok: false, status: 413, error: `screenshot larger than ${MAX_SCREENSHOT} bytes`, field: 'screenshot' }
    if (file.size > 0) {
      shot = new Uint8Array(await file.arrayBuffer())
      shotType = imageType(shot)
      if (!shotType) return { ok: false, status: 400, error: 'screenshot must be PNG or JPEG', field: 'screenshot' }
    }
  } else if (typeof file === 'string' && file) return { ok: false, status: 400, error: 'must be a file', field: 'screenshot' }

  return {
    ok: true,
    fields: { what: what as string, expected: expected as string, email, diagnostics: diagnostics as string, appVersion: appVersion as string, os: oneLine(os as string) },
    shot,
    shotType
  }
}

export function metaOf(r: SupportReport): ReportMeta {
  return { id: r.id, created: r.created, status: r.status, fixedIn: r.fixedIn, first: firstLine(r.what), appVersion: r.appVersion, os: r.os.slice(0, 60), shot: !!r.screenshot, plan: r.key.plan ?? null, email: !!r.email }
}

export async function putReport(kv: KVNamespace, r: SupportReport, nowMs: number): Promise<void> {
  // KV refuses an expiry less than 60 s away; a report that close to its end keeps a minute.
  const expiration = Math.max(r.expires, Math.floor(nowMs / 1000) + 60)
  await kv.put(REPORT_PREFIX + r.ref, JSON.stringify(r), { expiration, metadata: metaOf(r) })
}

export async function getReport(kv: KVNamespace, ref: string): Promise<SupportReport | null> {
  if (!REF_RE.test(ref)) return null
  const raw = await kv.get(REPORT_PREFIX + ref, 'text')
  if (!raw) return null
  try {
    const v = JSON.parse(raw) as SupportReport
    return v && v.ref === ref ? v : null
  } catch {
    return null
  }
}

/** POST /v1/support */
export async function handleSupportReport(request: Request, url: URL, env: SupportEnv, ctx: ExecutionContext, nowMs: number): Promise<Response> {
  const ct = request.headers.get('content-type') ?? ''
  if (!/^multipart\/form-data\s*;/i.test(ct)) return json({ error: 'send multipart/form-data' }, 415)
  if (!(await allow(env.PURCHASES, 'support', clientIp(request), SUPPORT_IP_LIMIT.n, SUPPORT_IP_LIMIT.windowSec, nowMs))) return json({ error: 'slow down' }, 429)

  const bytes = await readCapped(request, MAX_BODY)
  if (!bytes) return json({ error: 'report too large', limit: MAX_BODY }, 413)
  let form: FormData
  try {
    form = await new Response(bytes, { headers: { 'content-type': ct } }).formData()
  } catch {
    return json({ error: 'bad form' }, 400)
  }
  const p = await parseReport(form)
  if (!p.ok) return json({ error: p.error, ...(p.field ? { field: p.field } : {}) }, p.status)

  const key = await keyInfo(request, env, nowMs)
  if (key.sid && !(await allow(env.PURCHASES, 'support-key', key.sid, SUPPORT_KEY_LIMIT.n, SUPPORT_KEY_LIMIT.windowSec, nowMs))) return json({ error: 'slow down' }, 429)

  const id = newId()
  const report: SupportReport = {
    id,
    ref: refFor(nowMs, id),
    created: nowMs,
    expires: Math.floor(nowMs / 1000) + RETENTION_DAYS * 86400,
    status: 'new',
    fixedIn: null,
    note: '',
    updatedAt: null,
    ...p.fields,
    screenshot: p.shot && p.shotType ? { type: p.shotType, size: p.shot.byteLength } : null,
    key,
    noticed: false
  }
  // The screenshot first: a report that lists one can always show it.
  if (p.shot && p.shotType) await env.PURCHASES.put(SHOT_PREFIX + report.ref, p.shot, { expiration: report.expires, metadata: { type: p.shotType } })
  const notify = !!env.EMAIL && (await allow(env.PURCHASES, 'support-notice', 'all', NOTICE_DAY_LIMIT.n, NOTICE_DAY_LIMIT.windowSec, nowMs))
  await putReport(env.PURCHASES, report, nowMs)
  console.log(`[support] ${id} ${report.appVersion} key=${key.status}${report.screenshot ? ' +shot' : ''}`)

  if (notify && env.EMAIL) {
    const mailer = env.EMAIL
    ctx.waitUntil(
      (async () => {
        const msg = supportNotice(report, `${url.origin}/admin/support#${report.ref}`)
        const send = (replyTo: string) => mailer.send({ to: env.FROM_EMAIL, from: { email: env.FROM_EMAIL, name: env.FROM_NAME }, replyTo, subject: msg.subject, text: msg.text })
        try {
          // Reply-To is the reporter, so answering the notice answers them. An address the mail service
          // refuses must not lose the notice: send it again without.
          await send(report.email ?? env.FROM_EMAIL).catch((e) => (report.email ? send(env.FROM_EMAIL) : Promise.reject(e)))
          const cur = await getReport(env.PURCHASES, report.ref)
          if (cur) await putReport(env.PURCHASES, { ...cur, noticed: true }, nowMs)
        } catch (e) {
          console.error(`[support] notice for ${id} failed: ${String((e as { code?: string })?.code ?? e)}`)
        }
      })()
    )
  }
  return json({ ok: true, id }, 201)
}
