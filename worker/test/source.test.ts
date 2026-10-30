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
  it('an unsatisfiable Range is a 416 with the size, no body and no year-long cache', async () => {
    const w = withSource()
    for (const range of ['bytes=600-', 'bytes=6-', 'bytes=6-9', 'bytes=-0']) {
      const res = await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { headers: { range } }))
      expect(res.status, range).toBe(416)
      expect(res.headers.get('content-range')).toBe('bytes */6')
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('content-disposition')).toBeNull()
      expect(res.body).toBeNull()
    }
  })
  it('a Range it does not parse, or one covering everything, gets the whole file', async () => {
    const w = withSource()
    for (const range of ['bytes=5-2', 'bytes=0-1,3-4', 'items=0-1', 'bytes=0-', 'bytes=-99', 'bytes=0-99']) {
      const res = await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { headers: { range } }))
      expect(res.status, range).toBe(200)
      expect(res.headers.get('content-range')).toBeNull()
      expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
    }
    const end = await run(w, req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { headers: { range: 'bytes=4-99' } }))
    expect(end.status).toBe(206)
    expect(end.headers.get('content-range')).toBe('bytes 4-5/6')
  })
  it('only If-None-Match makes a 304; If-Match and If-Unmodified-Since are ignored', async () => {
    const w = withSource()
    const file = `/source/${REL}/ffmpeg-7.1.1.tar.xz`
    for (const headers of <Record<string, string>[]>[{ 'if-match': '"something-else"' }, { 'if-unmodified-since': 'Thu, 01 Jan 1970 00:00:00 GMT' }, { 'if-match': '"something-else"', range: 'bytes=2-3' }]) {
      const res = await run(w, req(file, { headers }))
      expect(res.status, JSON.stringify(headers)).toBe('range' in headers ? 206 : 200)
      expect(res.body).not.toBeNull()
    }
    const ranged304 = await run(w, req(file, { headers: { range: 'bytes=2-3', 'if-none-match': `"etag-source${file.slice(7)}"` } }))
    expect(ranged304.status).toBe(304)
  })
  it('If-Range: the same ETag gets the range, any other value the whole file', async () => {
    const w = withSource()
    const file = `/source/${REL}/ffmpeg-7.1.1.tar.xz`
    const same = await run(w, req(file, { headers: { range: 'bytes=2-3', 'if-range': `"etag-source/${REL}/ffmpeg-7.1.1.tar.xz"` } }))
    expect(same.status).toBe(206)
    for (const ifRange of ['"an-older-etag"', 'Thu, 01 Jan 2026 00:00:00 GMT']) {
      const other = await run(w, req(file, { headers: { range: 'bytes=2-3', 'if-range': ifRange } }))
      expect(other.status).toBe(200)
      expect(other.headers.get('content-range')).toBeNull()
      expect(new Uint8Array(await other.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3, 4, 5, 6]))
    }
    // and with no Range, If-Range changes nothing
    expect((await run(w, req(file, { headers: { 'if-range': '"x"' } }))).status).toBe(200)
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
  it('listings come from the cache: R2 is listed once per listing, not per request', async () => {
    const w = withSource()
    for (let i = 0; i < 3; i++) expect((await run(w, req('/source/'))).status).toBe(200)
    expect(w.r2.lists).toBe(1)
    for (let i = 0; i < 3; i++) {
      const res = await run(w, req(i % 2 ? `/source/${REL}` : `/source/${REL}/`))
      expect(res.status).toBe(200)
      expect(await res.text()).toContain('(6 bytes)')
    }
    expect(w.r2.lists).toBe(2)
    expect([...w.cache.store.keys()].sort()).toEqual(['https://dl.getreelstudio.com/source/?releases', `https://dl.getreelstudio.com/source/${REL}/`])
    const head = await run(w, req(`/source/${REL}/`, { method: 'HEAD' }))
    expect(head.status).toBe(200)
    expect(head.body).toBeNull()
    expect(await (await run(w, req(`/source/${REL}/`))).text()).toContain('(6 bytes)') // HEAD did not spoil the entry
    expect(w.r2.lists).toBe(2)
  })
  it('an unknown folder is a 404 without listing it in R2', async () => {
    const w = withSource()
    await run(w, req('/source/'))
    const before = w.r2.lists
    for (const name of ['nope', 'ffmpeg-9.9-rs9', 'a-b-c-d-e']) expect((await run(w, req(`/source/${name}/`))).status).toBe(404)
    expect(w.r2.lists).toBe(before)
    // cold cache: one list (the releases), never one per made-up folder
    const cold = withSource()
    for (const name of ['nope', 'other', 'third']) expect((await run(cold, req(`/source/${name}/`))).status).toBe(404)
    expect(cold.r2.lists).toBe(1)
  })
  it('a 404 is not cached', async () => {
    const w = withSource()
    await run(w, req('/source/ffmpeg-0.0-rs0/'))
    expect([...w.cache.store.keys()]).toEqual(['https://dl.getreelstudio.com/source/?releases'])
  })
  it('POST is not served', async () => {
    expect((await run(withSource(), req(`/source/${REL}/ffmpeg-7.1.1.tar.xz`, { method: 'POST' }))).status).toBe(404)
  })
})
