// Release administration, used only by the publish script (tools/publish.mjs) with the ADMIN_SECRET.
// Multipart upload because a single request to a Worker is capped at 100 MB and wrangler at 300 MiB,
// while the installers are 200-320 MB. Without ADMIN_SECRET configured every /admin route is a 404.
//
//   GET    /admin/objects                         list the bucket
//   DELETE /admin/objects?key=…                   remove one object (an old version)
//   POST   /admin/upload/start    {key}           → {uploadId}
//   PUT    /admin/upload/part?key&uploadId&part   body = the bytes → {partNumber, etag}
//   POST   /admin/upload/complete {key, uploadId, parts: [{partNumber, etag}]} → {key, size, etag}
//   POST   /admin/upload/abort    {key, uploadId}
//   PUT    /admin/manifest        the manifest    checks every file is in R2 at the stated size, then publishes
//   POST   /admin/link            {sid, plan?}    mint download links for one purchase (support: "resend my link")
import { MANIFEST_KEY, loadManifest, parseManifest, publicLatest, type ManifestFile } from './manifest'
import { getPurchase } from './records'
import { SESSION_ID_RE } from './stripe'
import { TOKEN_DAYS, mintToken, timingSafeEqual } from './token'

export interface AdminEnv {
  INSTALLERS: R2Bucket
  PURCHASES: KVNamespace
  SITE_ORIGIN: string
  ADMIN_SECRET?: string
  TOKEN_SECRET?: string
}

/** Objects live under a version folder: v0.1.3/Reel-Studio-Setup-0.1.3-x64.exe */
export const OBJECT_KEY_RE = /^v\d+\.\d+\.\d+\/[A-Za-z0-9._-]+$/
const enc = new TextEncoder()

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' } })
}

export function authorized(env: AdminEnv, request: Request): boolean {
  const secret = env.ADMIN_SECRET
  if (typeof secret !== 'string' || secret.length < 32) return false
  const h = request.headers.get('authorization') ?? ''
  if (!h.startsWith('Bearer ')) return false
  return timingSafeEqual(enc.encode(h.slice(7)), enc.encode(secret))
}

async function body<T>(request: Request): Promise<T | null> {
  try {
    const v = (await request.json()) as T
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

export async function handleAdmin(request: Request, url: URL, env: AdminEnv, nowMs: number): Promise<Response> {
  if (typeof env.ADMIN_SECRET !== 'string' || env.ADMIN_SECRET.length < 32) return json({ error: 'not found' }, 404)
  if (!authorized(env, request)) return json({ error: 'unauthorized' }, 401)
  const path = url.pathname
  const method = request.method

  if (path === '/admin/link' && method === 'POST') {
    const b = await body<{ sid?: unknown; plan?: unknown }>(request)
    const sid = typeof b?.sid === 'string' ? b.sid : ''
    if (!SESSION_ID_RE.test(sid)) return json({ error: 'bad session id' }, 400)
    if (typeof env.TOKEN_SECRET !== 'string' || env.TOKEN_SECRET.length < 16) return json({ error: 'TOKEN_SECRET not set' }, 503)
    const m = await loadManifest(env.PURCHASES)
    if (!m) return json({ error: 'no release' }, 503)
    const rec = await getPurchase(env.PURCHASES, sid)
    const plan = rec?.plan ?? (b?.plan === 'monthly' ? 'monthly' : 'once')
    const expires = Math.floor(nowMs / 1000) + TOKEN_DAYS * 86400
    const token = await mintToken(env.TOKEN_SECRET, { s: sid, p: plan, e: expires })
    const link = (f?: ManifestFile) => (f ? `${url.origin}/d/${token}/${encodeURIComponent(f.name)}` : undefined)
    return json({ sid, plan, onFile: !!rec, version: m.version, expires, token, win: link(m.files.win), mac: link(m.files.mac) })
  }

  if (path === '/admin/objects' && method === 'GET') {
    const out: { key: string; size: number; etag: string; uploaded: string }[] = []
    let cursor: string | undefined
    do {
      const page = await env.INSTALLERS.list({ cursor, limit: 1000 })
      for (const o of page.objects) out.push({ key: o.key, size: o.size, etag: o.httpEtag, uploaded: o.uploaded.toISOString() })
      cursor = page.truncated ? page.cursor : undefined
    } while (cursor)
    return json({ objects: out })
  }

  if (path === '/admin/objects' && method === 'DELETE') {
    const key = url.searchParams.get('key') ?? ''
    if (!OBJECT_KEY_RE.test(key)) return json({ error: 'bad key' }, 400)
    await env.INSTALLERS.delete(key)
    return json({ deleted: key })
  }

  if (path === '/admin/upload/start' && method === 'POST') {
    const b = await body<{ key?: unknown }>(request)
    const key = typeof b?.key === 'string' ? b.key : ''
    if (!OBJECT_KEY_RE.test(key)) return json({ error: 'bad key' }, 400)
    const mp = await env.INSTALLERS.createMultipartUpload(key, { httpMetadata: { contentType: 'application/octet-stream' } })
    return json({ key: mp.key, uploadId: mp.uploadId })
  }

  if (path === '/admin/upload/part' && method === 'PUT') {
    const key = url.searchParams.get('key') ?? ''
    const uploadId = url.searchParams.get('uploadId') ?? ''
    const part = Number(url.searchParams.get('part'))
    if (!OBJECT_KEY_RE.test(key) || !uploadId || !Number.isInteger(part) || part < 1 || part > 10000) return json({ error: 'bad part request' }, 400)
    if (!request.body) return json({ error: 'empty part' }, 400)
    const mp = env.INSTALLERS.resumeMultipartUpload(key, uploadId)
    const up = await mp.uploadPart(part, await request.arrayBuffer())
    return json({ partNumber: up.partNumber, etag: up.etag })
  }

  if (path === '/admin/upload/complete' && method === 'POST') {
    const b = await body<{ key?: unknown; uploadId?: unknown; parts?: unknown }>(request)
    const key = typeof b?.key === 'string' ? b.key : ''
    const uploadId = typeof b?.uploadId === 'string' ? b.uploadId : ''
    const parts = Array.isArray(b?.parts) ? (b!.parts as { partNumber?: unknown; etag?: unknown }[]) : null
    if (!OBJECT_KEY_RE.test(key) || !uploadId || !parts || parts.length === 0) return json({ error: 'bad complete request' }, 400)
    const clean: R2UploadedPart[] = []
    for (const p of parts) {
      if (!Number.isInteger(p.partNumber) || typeof p.etag !== 'string') return json({ error: 'bad part list' }, 400)
      clean.push({ partNumber: p.partNumber as number, etag: p.etag })
    }
    const obj = await env.INSTALLERS.resumeMultipartUpload(key, uploadId).complete(clean)
    return json({ key: obj.key, size: obj.size, etag: obj.httpEtag })
  }

  if (path === '/admin/upload/abort' && method === 'POST') {
    const b = await body<{ key?: unknown; uploadId?: unknown }>(request)
    const key = typeof b?.key === 'string' ? b.key : ''
    const uploadId = typeof b?.uploadId === 'string' ? b.uploadId : ''
    if (!OBJECT_KEY_RE.test(key) || !uploadId) return json({ error: 'bad abort request' }, 400)
    await env.INSTALLERS.resumeMultipartUpload(key, uploadId).abort()
    return json({ aborted: key })
  }

  if (path === '/admin/manifest' && method === 'PUT') {
    const m = parseManifest(await body(request))
    if (!m) return json({ error: 'malformed manifest' }, 400)
    const problems: string[] = []
    for (const f of [m.files.win, m.files.mac] as (ManifestFile | undefined)[]) {
      if (!f) continue
      if (!OBJECT_KEY_RE.test(f.key)) problems.push(`${f.name}: bad key ${f.key}`)
      else {
        const head = await env.INSTALLERS.head(f.key)
        if (!head) problems.push(`${f.name}: ${f.key} is not in the bucket`)
        else if (head.size !== f.size) problems.push(`${f.name}: bucket has ${head.size} bytes, manifest says ${f.size}`)
      }
    }
    if (problems.length) return json({ error: 'manifest does not match the bucket', problems }, 400)
    await env.PURCHASES.put(MANIFEST_KEY, JSON.stringify(m))
    return json({ published: publicLatest(m, env.SITE_ORIGIN + '/update.html') })
  }

  return json({ error: 'not found' }, 404)
}
