// The public source mirror: the corresponding source of the open-source programs inside the installers
// (FFmpeg and its libraries, GPL v3 section 6(d)). No token. Only keys under `source/` in the bucket, and
// only by a plain two-level name, so nothing here can reach an installer.
//
//   GET /source/                      the releases (folders) in the mirror
//   GET /source/<release>/            that release's files with their sizes
//   GET /source/<release>/<file>      one file (HEAD and Range work, like the installers)
//
// Files are uploaded by hand: `npx wrangler r2 object put reel-studio-installers/source/<release>/<file>
// --file <file> --content-type … --remote`. A release folder never changes once published, so files are
// cached for a year.
//
// Listing R2 is a billed operation, so the listings are kept in the Workers cache for LISTING_TTL (a new
// folder shows up within five minutes), and a folder name that is not among the releases is a 404 without
// asking R2 at all.
import { streamObject } from './serve'

export const SOURCE_PREFIX = 'source/'
export const LISTING_TTL = 300

/** One path segment: a release or a file name. No slashes, no percent-escapes, no "..". */
const SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/

function validSegment(s: string): boolean {
  return SEGMENT_RE.test(s) && !s.includes('..')
}

function contentType(name: string): string {
  if (name.endsWith('.gz') || name.endsWith('.tgz')) return 'application/gzip'
  if (name.endsWith('.xz')) return 'application/x-xz'
  if (name.endsWith('.zip')) return 'application/zip'
  if (name.endsWith('.asc')) return 'application/pgp-signature'
  if (name.endsWith('.txt')) return 'text/plain; charset=utf-8'
  return 'application/octet-stream'
}

function notFound(): Response {
  return new Response('Not found. The source files are listed at https://dl.getreelstudio.com/source/\n', {
    status: 404,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
  })
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`)

function page(request: Request, title: string, rows: string[]): Response {
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:760px;margin:48px auto;padding:0 24px;line-height:1.5"><h1 style="font-size:1.4em">${esc(title)}</h1><p>The corresponding source of the open-source programs inside the Reel Studio installers. What each file is: <a href="https://getreelstudio.com/source.html">getreelstudio.com/source.html</a>.</p><ul>${rows.join('')}</ul></body>`
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': `public, max-age=${LISTING_TTL}`, 'X-Content-Type-Options': 'nosniff' }
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers })
}

/** `make()`'s answer, from the cache when it is there (keyed by `key`, a URL); a 200 is stored for
 * LISTING_TTL. No cache (tests, `wrangler dev` without one): just make(). */
async function cached(cache: Cache | undefined, key: string, make: () => Promise<Response>): Promise<Response> {
  const hit = cache && (await cache.match(key))
  if (hit) return hit
  const res = await make()
  if (cache && res.status === 200) await cache.put(key, res.clone())
  return res
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<{ objects: { key: string; size: number }[]; prefixes: string[] }> {
  const objects: { key: string; size: number }[] = []
  const prefixes: string[] = []
  let cursor: string | undefined
  for (;;) {
    const r = await bucket.list({ prefix, delimiter: '/', cursor })
    for (const o of r.objects) objects.push({ key: o.key, size: o.size })
    for (const p of r.delimitedPrefixes ?? []) prefixes.push(p)
    if (!r.truncated) break
    cursor = r.cursor
  }
  return { objects, prefixes }
}

/** The release folders in the mirror, from the cache or one R2 list. */
async function releases(bucket: R2Bucket, cache: Cache | undefined, origin: string): Promise<string[]> {
  const res = await cached(cache, `${origin}/source/?releases`, async () => {
    const { prefixes } = await listAll(bucket, SOURCE_PREFIX)
    const names = prefixes.map((p) => p.slice(SOURCE_PREFIX.length, -1)).filter(validSegment)
    return new Response(JSON.stringify(names), { headers: { 'Content-Type': 'application/json', 'Cache-Control': `public, max-age=${LISTING_TTL}` } })
  })
  return (await res.json()) as string[]
}

/** A cached listing as the request wants it: HEAD gets the headers only. */
function asRequested(request: Request, res: Response): Response {
  return request.method === 'HEAD' ? new Response(null, { status: res.status, headers: res.headers }) : res
}

export async function handleSource(request: Request, url: URL, bucket: R2Bucket, cache?: Cache): Promise<Response> {
  // url.pathname is already normalised ("/source/../x" arrives as "/x"); the segment check covers the rest.
  const parts = url.pathname.split('/').slice(2) // drop "" and "source"
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop() // a trailing slash
  if (parts.length === 0) {
    const names = await releases(bucket, cache, url.origin)
    return page(request, 'Reel Studio: source downloads', names.map((r) => `<li><a href="/source/${esc(r)}/">${esc(r)}</a></li>`))
  }
  if (!parts.every(validSegment)) return notFound()
  if (parts.length === 1) {
    const [release] = parts
    if (!(await releases(bucket, cache, url.origin)).includes(release)) return notFound()
    const res = await cached(cache, `${url.origin}/source/${release}/`, async () => {
      const { objects } = await listAll(bucket, `${SOURCE_PREFIX}${release}/`)
      const files = objects.map((o) => ({ name: o.key.slice(SOURCE_PREFIX.length + release.length + 1), size: o.size })).filter((f) => validSegment(f.name))
      if (files.length === 0) return notFound()
      return page(
        new Request(request.url), // always the full page into the cache
        `Reel Studio: source for ${release}`,
        files.map((f) => `<li><a href="/source/${esc(release)}/${esc(f.name)}">${esc(f.name)}</a> (${f.size.toLocaleString('en-US')} bytes)</li>`)
      )
    })
    return asRequested(request, res)
  }
  if (parts.length !== 2) return notFound()
  const [release, name] = parts
  const headers = new Headers({
    'Content-Type': contentType(name),
    'Content-Disposition': `${name.endsWith('.txt') ? 'inline' : 'attachment'}; filename="${name}"`,
    'Cache-Control': 'public, max-age=31536000, immutable',
    'Access-Control-Allow-Origin': '*',
    'X-Content-Type-Options': 'nosniff',
    'Accept-Ranges': 'bytes'
  })
  const res = await streamObject(request, bucket, `${SOURCE_PREFIX}${release}/${name}`, headers)
  return res ?? notFound()
}
