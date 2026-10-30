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
import { streamObject } from './serve'

export const SOURCE_PREFIX = 'source/'

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
  const headers = { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'public, max-age=300', 'X-Content-Type-Options': 'nosniff' }
  return new Response(request.method === 'HEAD' ? null : html, { status: 200, headers })
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

export async function handleSource(request: Request, url: URL, bucket: R2Bucket): Promise<Response> {
  // url.pathname is already normalised ("/source/../x" arrives as "/x"); the segment check covers the rest.
  const parts = url.pathname.split('/').slice(2) // drop "" and "source"
  if (parts.length > 0 && parts[parts.length - 1] === '') parts.pop() // a trailing slash
  if (parts.length === 0) {
    const { prefixes } = await listAll(bucket, SOURCE_PREFIX)
    const releases = prefixes.map((p) => p.slice(SOURCE_PREFIX.length, -1)).filter(validSegment)
    return page(request, 'Reel Studio: source downloads', releases.map((r) => `<li><a href="/source/${esc(r)}/">${esc(r)}</a></li>`))
  }
  if (!parts.every(validSegment)) return notFound()
  if (parts.length === 1) {
    const [release] = parts
    const { objects } = await listAll(bucket, `${SOURCE_PREFIX}${release}/`)
    const files = objects.map((o) => ({ name: o.key.slice(SOURCE_PREFIX.length + release.length + 1), size: o.size })).filter((f) => validSegment(f.name))
    if (files.length === 0) return notFound()
    return page(
      request,
      `Reel Studio: source for ${release}`,
      files.map((f) => `<li><a href="/source/${esc(release)}/${esc(f.name)}">${esc(f.name)}</a> (${f.size.toLocaleString('en-US')} bytes)</li>`)
    )
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
