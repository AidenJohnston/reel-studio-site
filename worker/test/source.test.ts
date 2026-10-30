import { describe, expect, it } from 'vitest'
import { handle } from '../src/app'
import { MANIFEST, deps, req, world } from './fakes'

const run = (w: ReturnType<typeof world>, r: Request) => handle(r, w.env, w.ctx, deps(w))
const REL = 'ffmpeg-7.1.1-rs2'

function withSource() {
  const w = world({ secrets: false })
  w.r2.objects.set(`source/${REL}/ffmpeg-7.1.1.tar.xz`, new Uint8Array([1, 2, 3, 4, 5, 6]))
  w.r2.objects.set(`source/${REL}/x264-373697b4.tar.gz`, new Uint8Array([7, 8]))
  w.r2.objects.set(`source/${REL}/SHA256SUMS.txt`, new TextEncoder().encode('abc  ffmpeg-7.1.1.tar.xz\n'))
  return w
}

describe('GET /source/<release>/<file>', () => {
  it('streams a file with no token: right type, attachment, cached a year, open to any origin', async () => {
    const w = withSource()
    const res = await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`))
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toBe('application/x-xz')
    expect(res.headers.get('content-disposition')).toBe('attachment; filename="ffmpeg-7.1.1.tar.xz"')
    expect(res.headers.get('cache-control')).toBe('public, max-age=31536000, immutable')
    expect(res.headers.get('access-control-allow-origin')).toBe('*')
    expect(res.headers.get('accept-ranges')).toBe('bytes')
    expect(res.headers.get('content-length')).toBe('6')
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
    const gz = await run(w, req(`/source/${REL}/x264-373697b4.tar.gz`))
    expect(gz.headers.get('content-type')).toBe('application/gzip')
  })
  it('text files open in the browser', async () => {
    const res = await run(withSource(), req(`/source/${REL}/SHA256SUMS.txt`))
    expect(res.headers.get('content-type')).toBe('text/plain; charset=utf-8')
    expect(res.headers.get('content-disposition')).toBe('inline; filename="SHA256SUMS.txt"')
    expect(await res.text()).toContain('ffmpeg-7.1.1.tar.xz')
  })
  it('honours a Range, a suffix Range, HEAD and If-None-Match', async () => {
    const w = withSource()
    const r = await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { headers: { range: 'bytes=2-3' } }))
    expect(r.status).toBe(206)
    expect(r.headers.get('content-range')).toBe('bytes 2-3/6')
    expect(r.headers.get('content-length')).toBe('2')
    expect(new Uint8Array(await r.arrayBuffer())).toEqual(new Uint8Array([3, 4]))
    const suffix = await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { headers: { range: 'bytes=-1' } }))
    expect(suffix.status).toBe(206)
    expect(suffix.headers.get('content-range')).toBe('bytes 5-5/6')
    const head = await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.headers.get('content-length')).toBe('6')
    expect(head.headers.get('content-type')).toBe('application/x-xz')
    expect(head.body).toBeNull()
    const cached = await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { headers: { 'if-none-match': `"etag-source/${REL}/ffmpeg-7.1.1.tar.xz"` } }))
    expect(cached.status).toBe(304)
  })
  it('a file that is not there is a 404', async () => {
    const w = withSource()
    expect((await run(w, req(`/source/${REL}/nope.tar.gz`))).status).toBe(404)
    expect((await run(w, req('/source/ffmpeg-9.9-rs9/ffmpeg-7.1.1.tar.xz'))).status).toBe(404)
    expect((await run(w, req(`/source/${REL}/nope.tar.gz`, { method: 'HEAD' }))).status).toBe(404)
  })
  it('works without any secret configured (it is public)', async () => {
    const w = withSource()
    expect(w.env.TOKEN_SECRET).toBeUndefined()
    expect((await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`))).status).toBe(200)
  })
})

describe('the source route never reaches an installer', () => {
  const win = MANIFEST.files.win
  const escapes = [
    `/source/../${win.key}`, // normalised by the URL parser to /v0.1.2/…, a 404 elsewhere
    `/source/%2e%2e/${win.key}`,
    `/source/${REL}/../../${win.key}`,
    `/source/..%2F${win.key.replace('/', '%2F')}`,
    `/source/${REL}/..%2F..%2F${win.key.replace('/', '%2F')}`,
    `/source/${win.key}`, // "source/v0.1.2/…" is not "v0.1.2/…"
    `/source/v0.1.2/`,
    `/source/v0.1.2`,
    `/source/${REL}/%2e%2e%2fv0.1.2%2f${win.name}`,
    `/source/${REL}//${win.name}`,
    `/source//v0.1.2/${win.name}`,
    `/source/${REL}/sub/${win.name}`,
    `/source/${REL}/.${win.name}`,
    `/source%2F${win.key.replace('/', '%2F')}`,
    `/sourcev0.1.2/${win.name}`,
    `/${win.key}`
  ]
  for (const path of escapes)
    it(`${path} → 404`, async () => {
      const w = withSource()
      for (const method of ['GET', 'HEAD']) {
        const res = await run(w, req(path, { method }))
        expect(res.status).toBe(404)
        if (method === 'GET') {
          const body = new Uint8Array(await res.arrayBuffer())
          expect(body).not.toEqual(new Uint8Array([1, 2, 3, 4, 5]))
        }
      }
    })
  it('does not list installer folders or other prefixes', async () => {
    const w = withSource()
    w.r2.objects.set('sources-not-really/x.tar.gz', new Uint8Array([1]))
    const index = await (await run(w, req('/source/'))).text()
    expect(index).not.toContain('v0.1.2')
    expect(index).not.toContain('sources-not-really')
  })
})

describe('GET /source/ listings', () => {
  it('/source/ lists the releases', async () => {
    const w = withSource()
    for (const path of ['/source/', '/source']) {
      const res = await run(w, req(path))
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toBe('text/html; charset=utf-8')
      const html = await res.text()
      expect(html).toContain(`<a href="/source/${REL}/">${REL}</a>`)
      expect(html).toContain('https://getreelstudio.com/source.html')
    }
  })
  it('/source/<release>/ lists its files with sizes', async () => {
    const w = withSource()
    for (const path of [`/source/${REL}/`, `/source/${REL}`]) {
      const res = await run(w, req(path))
      expect(res.status).toBe(200)
      const html = await res.text()
      expect(html).toContain(`<a href="/source/${REL}/ffmpeg-7.1.1.tar.xz">ffmpeg-7.1.1.tar.xz</a> (6 bytes)`)
      expect(html).toContain('x264-373697b4.tar.gz')
      expect(html).toContain('SHA256SUMS.txt')
    }
  })
  it('HEAD on a listing has no body', async () => {
    const res = await run(withSource(), req('/source/', { method: 'HEAD' }))
    expect(res.status).toBe(200)
    expect(res.body).toBeNull()
  })
  it('an empty or unknown release is a 404', async () => {
    expect((await run(withSource(), req('/source/ffmpeg-0.0-rs0/'))).status).toBe(404)
  })
  it('POST is not served', async () => {
    expect((await run(withSource(), req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { method: 'POST' }))).status).toBe(404)
  })
})
