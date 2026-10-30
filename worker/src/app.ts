// dl.getreelstudio.com: the Worker that hands paying customers their installer. (index.ts is the entry; this
// module holds the routes so that the entry exports nothing but the handler, which the runtime insists on.)
//
//   GET  /latest.json              version + file names/hashes + the page to open (the app's update check)
//   GET  /api/claim?session_id=…   the thanks page: confirm the Checkout Session was paid, answer links
//   GET  /api/claim?token=…        the update page: links for the current version from a remembered token
//   GET  /d/<token>/<file>         the installer itself, streamed from R2 (resumable)
//   POST /api/link  {email}        "email me my link" (always answers ok; sends only if we have a purchase)
//   POST /stripe/webhook           checkout.session.completed → purchase record (signature checked)
//   GET  /source/<release>/<file>  public, no token: the open-source parts' source (src/source.ts)
//
// No account, no cookie, no analytics. A purchase record is a session id, a plan, a keyed hash of the
// buyer's email, and timestamps. Logs carry a short session id and a file name, nothing else.
import { handleAdmin } from './admin'
import { linkEmail } from './email'
import { fileByName, loadManifest, publicLatest, type Manifest, type ManifestFile } from './manifest'
import { allow, clientIp } from './ratelimit'
import { findByEmailHash, getPurchase, markReceipt, recordPurchase, type Purchase } from './records'
import { streamObject } from './serve'
import { handleSource } from './source'
import { SESSION_ID_RE, fetchSession, sessionEmail, sessionIsPaid, sessionPlan, verifyStripeSignature, type StripeSession } from './stripe'
import { TOKEN_DAYS, hashEmail, mintToken, normalizeEmail, verifyToken, type Plan } from './token'

export interface Env {
  PURCHASES: KVNamespace
  INSTALLERS: R2Bucket
  EMAIL?: SendEmail
  SITE_ORIGIN: string
  FROM_EMAIL: string
  FROM_NAME: string
  TOKEN_SECRET?: string
  STRIPE_SECRET_KEY?: string
  STRIPE_WEBHOOK_SECRET?: string
  /** For the publish script only (src/admin.ts). Unset = no /admin routes. */
  ADMIN_SECRET?: string
}

export interface Deps {
  fetch: typeof fetch
  /** ms since 1970 */
  now(): number
}

export const CLAIM_LIMIT = { n: 60, windowSec: 3600 }
export const LINK_LIMIT = { n: 5, windowSec: 3600 }
export const UPDATE_PAGE_PATH = '/update.html'

export async function handle(request: Request, env: Env, ctx: ExecutionContext, deps: Deps): Promise<Response> {
  const url = new URL(request.url)
  const path = url.pathname
  if (request.method === 'OPTIONS') return preflight(env, path)
  try {
    // `return await`: a rejected route must land in this catch, not escape as an unhandled rejection.
    if (path === '/latest.json' && request.method === 'GET') return await latest(env)
    if (path === '/api/claim' && request.method === 'GET') return await claim(request, url, env, deps)
    if (path === '/api/link' && request.method === 'POST') return await link(request, url, env, ctx, deps)
    if (path === '/stripe/webhook' && request.method === 'POST') return await webhook(request, env, ctx, deps)
    if (path.startsWith('/d/') && (request.method === 'GET' || request.method === 'HEAD')) return await download(request, url, env, deps)
    if ((path === '/source' || path.startsWith('/source/')) && (request.method === 'GET' || request.method === 'HEAD')) return await handleSource(request, url, env.INSTALLERS)
    if (path.startsWith('/admin/')) return await handleAdmin(request, url, env, deps.now())
    if (path === '/' || path === '') return Response.redirect(`${env.SITE_ORIGIN}/`, 302)
    return json({ error: 'not found' }, 404, env)
  } catch (e) {
    console.error(`[downloads] ${request.method} ${path}: ${String((e as Error)?.stack ?? e).slice(0, 500)}`)
    return json({ error: 'server error' }, 500, env)
  }
}

// ---- helpers ----------------------------------------------------------------------------------------

function cors(env: Env, h: Headers, path: string) {
  // /latest.json is public metadata; the API answers only the site.
  h.set('Access-Control-Allow-Origin', path === '/latest.json' ? '*' : env.SITE_ORIGIN)
  h.set('Vary', 'Origin')
}

function json(body: unknown, status: number, env: Env, extra: Record<string, string> = {}, path = '/api/'): Response {
  const h = new Headers({ 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...extra })
  cors(env, h, path)
  return new Response(JSON.stringify(body), { status, headers: h })
}

function preflight(env: Env, path: string): Response {
  const h = new Headers({ 'Access-Control-Allow-Methods': 'GET, POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Access-Control-Max-Age': '86400' })
  cors(env, h, path)
  return new Response(null, { status: 204, headers: h })
}

function secretOr503(env: Env, name: 'TOKEN_SECRET' | 'STRIPE_SECRET_KEY' | 'STRIPE_WEBHOOK_SECRET'): string | null {
  const v = env[name]
  return typeof v === 'string' && v.length >= 16 ? v : null
}

function shortSid(sid: string): string {
  return sid.slice(0, 8) + '…' + sid.slice(-4)
}

function downloadUrl(origin: string, token: string, f: ManifestFile): string {
  return `${origin}/d/${token}/${encodeURIComponent(f.name)}`
}

function filesWithLinks(m: Manifest, origin: string, token: string) {
  const one = (f?: ManifestFile) => (f ? { name: f.name, size: f.size, sha256: f.sha256, url: downloadUrl(origin, token, f) } : undefined)
  return { win: one(m.files.win), mac: one(m.files.mac) }
}

function purchaseFromSession(s: StripeSession, emailHash: string | null, source: Purchase['source'], nowMs: number): Purchase {
  return { sid: s.id, plan: sessionPlan(s), emailHash, customer: typeof s.customer === 'string' ? s.customer : null, created: s.created ?? Math.floor(nowMs / 1000), recordedAt: nowMs, source }
}

async function mintFor(secret: string, sid: string, plan: Plan, nowMs: number): Promise<{ token: string; expires: number }> {
  const expires = Math.floor(nowMs / 1000) + TOKEN_DAYS * 86400
  return { token: await mintToken(secret, { s: sid, p: plan, e: expires }), expires }
}

// ---- routes -----------------------------------------------------------------------------------------

async function latest(env: Env): Promise<Response> {
  const m = await loadManifest(env.PURCHASES)
  if (!m) return json({ error: 'no release' }, 503, env, {}, '/latest.json')
  return json(publicLatest(m, env.SITE_ORIGIN + UPDATE_PAGE_PATH), 200, env, { 'Cache-Control': 'public, max-age=300' }, '/latest.json')
}

/** The thanks page (session_id) or the update page (token). Answers the plan, the version and tokenised links. */
async function claim(request: Request, url: URL, env: Env, deps: Deps): Promise<Response> {
  const secret = secretOr503(env, 'TOKEN_SECRET')
  if (!secret) return json({ error: 'not configured' }, 503, env)
  const nowMs = deps.now()
  if (!(await allow(env.PURCHASES, 'claim', clientIp(request), CLAIM_LIMIT.n, CLAIM_LIMIT.windowSec, nowMs))) return json({ error: 'slow down' }, 429, env)

  const m = await loadManifest(env.PURCHASES)
  if (!m) return json({ error: 'no release' }, 503, env)

  let sid: string
  let plan: Plan
  const token = url.searchParams.get('token')
  const sessionId = url.searchParams.get('session_id')
  if (token) {
    const c = await verifyToken(secret, token, Math.floor(nowMs / 1000))
    if (!c) return json({ error: 'bad token' }, 401, env)
    sid = c.s
    plan = c.p
  } else {
    if (!sessionId || !SESSION_ID_RE.test(sessionId)) return json({ error: 'bad session id' }, 400, env)
    sid = sessionId
    let rec = await getPurchase(env.PURCHASES, sid)
    if (!rec) {
      const key = secretOr503(env, 'STRIPE_SECRET_KEY')
      if (!key) return json({ error: 'not configured' }, 503, env)
      const r = await fetchSession(deps.fetch, key, sid)
      if (r.kind === 'missing') return json({ error: 'unknown session' }, 404, env)
      if (r.kind === 'error') {
        console.error(`[downloads] stripe ${r.status} for ${shortSid(sid)}`)
        return json({ error: 'stripe unavailable' }, 503, env)
      }
      if (!sessionIsPaid(r.session)) return json({ error: 'not paid', status: r.session.payment_status ?? null }, 402, env)
      const email = normalizeEmail(sessionEmail(r.session))
      rec = await recordPurchase(env.PURCHASES, purchaseFromSession(r.session, email ? await hashEmail(secret, email) : null, 'claim', nowMs))
      console.log(`[downloads] claim ${shortSid(sid)} ${rec.plan} (stripe)`)
    }
    plan = rec.plan
  }
  const minted = token ? { token, expires: null } : await mintFor(secret, sid, plan, nowMs)
  return json({ ok: true, plan, version: m.version, token: minted.token, expires: minted.expires, files: filesWithLinks(m, url.origin, minted.token) }, 200, env)
}

/** The installer. The token must verify; the file name must be one of the current release's. */
async function download(request: Request, url: URL, env: Env, deps: Deps): Promise<Response> {
  const secret = secretOr503(env, 'TOKEN_SECRET')
  if (!secret) return json({ error: 'not configured' }, 503, env)
  const [, , token, ...rest] = url.pathname.split('/')
  const name = decodeURIComponent(rest.join('/'))
  const c = await verifyToken(secret, token, Math.floor(deps.now() / 1000))
  if (!c) return notValid(env)
  const m = await loadManifest(env.PURCHASES)
  const f = m && fileByName(m, name)
  if (!f) return json({ error: 'no such file in the current release' }, 404, env)

  const headers = new Headers({
    'Content-Disposition': `attachment; filename="${f.name}"`,
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'private, no-store',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes'
  })
  const res = await streamObject(request, env.INSTALLERS, f.key, headers)
  if (!res) return json({ error: 'file missing' }, 404, env)
  if (request.method === 'GET' && res.status !== 304) console.log(`[downloads] get ${f.name} ${c.p} ${shortSid(c.s)}${res.status === 206 ? ' (range)' : ''}`)
  return res
}

function notValid(env: Env): Response {
  const page = env.SITE_ORIGIN + UPDATE_PAGE_PATH
  const html = `<!doctype html><meta charset="utf-8"><title>Link not valid</title><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:48px auto;padding:0 24px;line-height:1.5"><h1>This download link is not valid</h1><p>It may have expired or been copied incompletely. <a href="${page}">Get a fresh link</a> with the email you bought with.</p></body>`
  return new Response(html, { status: 401, headers: { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' } })
}

/** "Email me my link". Always 200 with the delivery mode; never says whether the address bought. */
async function link(request: Request, url: URL, env: Env, ctx: ExecutionContext, deps: Deps): Promise<Response> {
  const secret = secretOr503(env, 'TOKEN_SECRET')
  if (!secret) return json({ error: 'not configured' }, 503, env)
  const nowMs = deps.now()
  const delivery = env.EMAIL ? 'email' : 'support'
  if (!(await allow(env.PURCHASES, 'link', clientIp(request), LINK_LIMIT.n, LINK_LIMIT.windowSec, nowMs))) return json({ error: 'slow down' }, 429, env)
  let body: unknown
  try {
    body = await request.json()
  } catch {
    return json({ error: 'bad request' }, 400, env)
  }
  const email = normalizeEmail((body as { email?: unknown })?.email)
  if (!email) return json({ error: 'bad email' }, 400, env)
  if (delivery === 'email') {
    ctx.waitUntil(
      (async () => {
        const rec = await findByEmailHash(env.PURCHASES, await hashEmail(secret, email))
        if (rec) await sendLinks(env, url.origin, secret, email, rec, 'resend', nowMs)
      })()
    )
  }
  return json({ ok: true, delivery }, 200, env)
}

/** Mint fresh links for one purchase and email them. Never throws: a failed email is logged, nothing more. */
async function sendLinks(env: Env, origin: string, secret: string, email: string, rec: Purchase, reason: 'receipt' | 'resend', nowMs: number): Promise<boolean> {
  if (!env.EMAIL) return false
  const m = await loadManifest(env.PURCHASES)
  if (!m) return false
  const { token } = await mintFor(secret, rec.sid, rec.plan, nowMs)
  const files = filesWithLinks(m, origin, token)
  const msg = linkEmail({ reason, plan: rec.plan, version: m.version, win: files.win, mac: files.mac, siteOrigin: env.SITE_ORIGIN, supportEmail: env.FROM_EMAIL })
  try {
    await env.EMAIL.send({ to: email, from: { email: env.FROM_EMAIL, name: env.FROM_NAME }, replyTo: env.FROM_EMAIL, subject: msg.subject, text: msg.text, html: msg.html })
    console.log(`[downloads] ${reason} emailed for ${shortSid(rec.sid)}`)
    return true
  } catch (e) {
    console.error(`[downloads] ${reason} email failed for ${shortSid(rec.sid)}: ${String((e as { code?: string })?.code ?? e)}`)
    return false
  }
}

/** Stripe → us. Records the purchase and emails the download links, so a buyer who closed the thanks page
 * (or never reached it) still gets what they paid for. */
async function webhook(request: Request, env: Env, ctx: ExecutionContext, deps: Deps): Promise<Response> {
  const whsec = secretOr503(env, 'STRIPE_WEBHOOK_SECRET')
  const secret = secretOr503(env, 'TOKEN_SECRET')
  if (!whsec || !secret) return json({ error: 'not configured' }, 503, env)
  const body = await request.text()
  const nowMs = deps.now()
  if (!(await verifyStripeSignature(whsec, request.headers.get('stripe-signature'), body, Math.floor(nowMs / 1000)))) return json({ error: 'bad signature' }, 400, env)
  let event: { type?: string; data?: { object?: StripeSession } }
  try {
    event = JSON.parse(body)
  } catch {
    return json({ error: 'bad json' }, 400, env)
  }
  const type = event?.type
  const s = event?.data?.object
  if ((type === 'checkout.session.completed' || type === 'checkout.session.async_payment_succeeded') && s && typeof s.id === 'string' && SESSION_ID_RE.test(s.id)) {
    if (sessionIsPaid(s)) {
      const email = normalizeEmail(sessionEmail(s))
      const rec = await recordPurchase(env.PURCHASES, purchaseFromSession(s, email ? await hashEmail(secret, email) : null, 'webhook', nowMs))
      console.log(`[downloads] webhook ${type} ${shortSid(s.id)} ${rec.plan}`)
      // The receipt with the links. Stripe retries a failed delivery, so the record above (first write wins)
      // and the `receiptAt` mark keep a retried event from sending twice.
      if (email && env.EMAIL && !rec.receiptAt) {
        const origin = new URL(request.url).origin
        ctx.waitUntil(
          (async () => {
            if (await sendLinks(env, origin, secret, email, rec, 'receipt', nowMs)) await markReceipt(env.PURCHASES, rec, nowMs)
          })()
        )
      }
    } else console.log(`[downloads] webhook ${type} ${shortSid(s.id)} not paid (${s.payment_status ?? '?'})`)
  }
  return json({ received: true }, 200, env)
}
