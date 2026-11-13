// The internal support dashboard: reports from the app's "Report a problem" form (support.ts).
//
//   GET    /admin/support                      the dashboard page (holds no data; asks for the secret)
//   GET    /admin/support/app.js               its script
//   GET    /admin/support/api/reports?status=&cursor=   newest first, 100 a page
//   GET    /admin/support/api/report?ref=…              one report
//   GET    /admin/support/api/screenshot?ref=…          its screenshot
//   POST   /admin/support/api/report?ref=…  {status, fixedIn?, note?}   set status and the internal note
//   DELETE /admin/support/api/report?ref=…              delete the report and its screenshot now
//
// The api/ routes need `Authorization: Bearer <secret>`, checked like every /admin route: ADMIN_SECRET, or
// SUPPORT_ADMIN_SECRET, which opens these routes and nothing else (for someone who triages reports but does not
// publish releases). With neither set, every path here is a 404. The page and its script are served without
// the secret because a browser cannot send a header when it opens a URL; they contain no report data and fetch
// it with the secret the admin types, kept in that tab's sessionStorage. Because the secret travels in a header
// and never in a cookie, another site cannot make the admin's browser act on these routes.
import { timingSafeEqual } from './token'
import { FIELD_CAPS, REF_RE, REPORT_PREFIX, SHOT_PREFIX, STATUSES, cleanText, getReport, putReport, type ReportMeta, type Status } from './support'
import { DASHBOARD_HTML, DASHBOARD_JS } from './support-page'

export interface SupportAdminEnv {
  PURCHASES: KVNamespace
  ADMIN_SECRET?: string
  SUPPORT_ADMIN_SECRET?: string
}

const enc = new TextEncoder()
const PAGE_SIZE = 100
const FIXED_IN_RE = /^v?[0-9A-Za-z][0-9A-Za-z.+-]{0,39}$/

const usable = (s: unknown): s is string => typeof s === 'string' && s.length >= 32

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } })
}

export function supportAuthorized(env: SupportAdminEnv, request: Request): boolean {
  const h = request.headers.get('authorization') ?? ''
  if (!h.startsWith('Bearer ')) return false
  const given = enc.encode(h.slice(7))
  let ok = false
  // Both compared every time, so the answer takes as long whichever one matched.
  for (const s of [env.ADMIN_SECRET, env.SUPPORT_ADMIN_SECRET]) if (usable(s) && timingSafeEqual(given, enc.encode(s))) ok = true
  return ok
}

const PAGE_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'X-Robots-Tag': 'noindex, nofollow',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'"
}

export async function handleSupportAdmin(request: Request, url: URL, env: SupportAdminEnv, nowMs: number): Promise<Response> {
  if (!usable(env.ADMIN_SECRET) && !usable(env.SUPPORT_ADMIN_SECRET)) return json({ error: 'not found' }, 404)
  const path = url.pathname
  const method = request.method

  if ((path === '/admin/support' || path === '/admin/support/') && method === 'GET') return new Response(DASHBOARD_HTML, { headers: { 'Content-Type': 'text/html; charset=utf-8', ...PAGE_HEADERS } })
  if (path === '/admin/support/app.js' && method === 'GET') return new Response(DASHBOARD_JS, { headers: { 'Content-Type': 'text/javascript; charset=utf-8', ...PAGE_HEADERS } })
  if (!path.startsWith('/admin/support/api/')) return json({ error: 'not found' }, 404)
  if (!supportAuthorized(env, request)) return json({ error: 'unauthorized' }, 401)

  if (path === '/admin/support/api/reports' && method === 'GET') {
    const status = url.searchParams.get('status') ?? ''
    if (status && !STATUSES.includes(status as Status)) return json({ error: 'bad status' }, 400)
    const out: (ReportMeta & { ref: string })[] = []
    let cursor = url.searchParams.get('cursor') || undefined
    // With a status filter, keep reading pages until one is full or the list ends (at most 10 KV lists).
    for (let i = 0; i < 10; i++) {
      const page = await env.PURCHASES.list<ReportMeta>({ prefix: REPORT_PREFIX, limit: PAGE_SIZE, cursor })
      for (const k of page.keys) {
        const ref = k.name.slice(REPORT_PREFIX.length)
        if (!REF_RE.test(ref) || !k.metadata) continue
        if (status && k.metadata.status !== status) continue
        out.push({ ref, ...k.metadata })
      }
      cursor = page.list_complete ? undefined : page.cursor
      if (!cursor || !status || out.length >= PAGE_SIZE) break
    }
    return json({ reports: out, cursor: cursor ?? null })
  }

  const ref = url.searchParams.get('ref') ?? ''
  if (!REF_RE.test(ref)) return json({ error: 'bad ref' }, 400)

  if (path === '/admin/support/api/report' && method === 'GET') {
    const r = await getReport(env.PURCHASES, ref)
    return r ? json({ report: r }) : json({ error: 'not found' }, 404)
  }

  if (path === '/admin/support/api/screenshot' && method === 'GET') {
    const r = await getReport(env.PURCHASES, ref)
    if (!r?.screenshot) return json({ error: 'not found' }, 404)
    const bytes = await env.PURCHASES.get(SHOT_PREFIX + ref, 'arrayBuffer')
    if (!bytes) return json({ error: 'not found' }, 404)
    return new Response(bytes, {
      headers: { 'Content-Type': r.screenshot.type, 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox", 'Content-Disposition': `inline; filename="${r.id}.${r.screenshot.type === 'image/png' ? 'png' : 'jpg'}"` }
    })
  }

  if (path === '/admin/support/api/report' && method === 'POST') {
    let b: { status?: unknown; fixedIn?: unknown; note?: unknown }
    try {
      b = (await request.json()) as typeof b
    } catch {
      return json({ error: 'bad request' }, 400)
    }
    if (!b || typeof b !== 'object' || !STATUSES.includes(b.status as Status)) return json({ error: 'bad status', allowed: STATUSES }, 400)
    const status = b.status as Status
    let fixedIn: string | null = null
    if (status === 'fixed') {
      const v = cleanText(b.fixedIn)
      if (!v || v.length > FIELD_CAPS.fixedIn || !FIXED_IN_RE.test(v)) return json({ error: 'fixed needs the version it shipped in', field: 'fixedIn' }, 400)
      fixedIn = v.replace(/^v/, '')
    }
    const note = b.note === undefined ? undefined : cleanText(b.note)
    if (note !== undefined && note.length > FIELD_CAPS.note) return json({ error: `note longer than ${FIELD_CAPS.note} characters`, field: 'note' }, 400)
    const r = await getReport(env.PURCHASES, ref)
    if (!r) return json({ error: 'not found' }, 404)
    const next = { ...r, status, fixedIn, note: note ?? r.note, updatedAt: nowMs }
    await putReport(env.PURCHASES, next, nowMs)
    return json({ report: next })
  }

  if (path === '/admin/support/api/report' && method === 'DELETE') {
    const r = await getReport(env.PURCHASES, ref)
    if (!r) return json({ error: 'not found' }, 404)
    await env.PURCHASES.delete(SHOT_PREFIX + ref)
    await env.PURCHASES.delete(REPORT_PREFIX + ref)
    return json({ deleted: r.id })
  }

  return json({ error: 'not found' }, 404)
}
