import { describe, expect, it } from 'vitest'
import { handle } from '../src/app'
import { ADMIN, MANIFEST, deps, req, world } from './fakes'

const run = (w: ReturnType<typeof world>, r: Request) => handle(r, w.env, w.ctx, deps(w))
const auth = { authorization: `Bearer ${ADMIN}` }
const post = (path: string, body: unknown, headers: Record<string, string> = auth) => req(path, { method: 'POST', body: JSON.stringify(body), headers })
const put = (path: string, body: BodyInit, headers: Record<string, string> = auth) => req(path, { method: 'PUT', body, headers })

describe('/admin authentication', () => {
  it('without ADMIN_SECRET configured every admin path is a 404', async () => {
    const w = world()
    expect((await run(w, req('/admin/objects', { headers: auth }))).status).toBe(404)
    expect((await run(w, req('/admin/objects'))).status).toBe(404)
  })
  it('with it: no header or a wrong one is 401, the right one works', async () => {
    const w = world({ admin: true })
    expect((await run(w, req('/admin/objects'))).status).toBe(401)
    expect((await run(w, req('/admin/objects', { headers: { authorization: `Bearer ${ADMIN.slice(0, -1)}x` } }))).status).toBe(401)
    expect((await run(w, req('/admin/objects', { headers: { authorization: ADMIN } }))).status).toBe(401)
    const ok = await run(w, req('/admin/objects', { headers: auth }))
    expect(ok.status).toBe(200)
    const b = (await ok.json()) as { objects: { key: string; size: number }[] }
    expect(b.objects.map((o) => [o.key, o.size])).toEqual([
      ['v0.1.2/Reel-Studio-Setup-0.1.2-x64.exe', 5],
      ['v0.1.2/Reel-Studio-0.1.2-arm64.dmg', 3]
    ])
  })
})

describe('multipart upload', () => {
  it('start, parts, complete: the object is the parts in order', async () => {
    const w = world({ admin: true })
    const key = 'v0.1.3/Reel-Studio-Setup-0.1.3-x64.exe'
    const start = (await (await run(w, post('/admin/upload/start', { key }))).json()) as { uploadId: string }
    expect(start.uploadId).toBeTruthy()
    const p1 = (await (await run(w, put(`/admin/upload/part?key=${key}&uploadId=${start.uploadId}&part=1`, new Uint8Array([1, 2, 3])))).json()) as { etag: string }
    const p2 = (await (await run(w, put(`/admin/upload/part?key=${key}&uploadId=${start.uploadId}&part=2`, new Uint8Array([4, 5])))).json()) as { etag: string }
    const done = await run(w, post('/admin/upload/complete', { key, uploadId: start.uploadId, parts: [{ partNumber: 1, etag: p1.etag }, { partNumber: 2, etag: p2.etag }] }))
    expect(done.status).toBe(200)
    expect(await done.json()).toMatchObject({ key, size: 5 })
    expect(w.r2.objects.get(key)).toEqual(new Uint8Array([1, 2, 3, 4, 5]))
  })
  it('keys must sit under a version folder; junk requests are 400', async () => {
    const w = world({ admin: true })
    for (const key of ['Reel-Studio-Setup-0.1.3-x64.exe', '../x', 'v0.1.3/../../x', 'v0.1.3/a b', '']) expect((await run(w, post('/admin/upload/start', { key }))).status).toBe(400)
    expect((await run(w, put('/admin/upload/part?key=v0.1.3/x.exe&uploadId=u&part=0', new Uint8Array([1])))).status).toBe(400)
    expect((await run(w, post('/admin/upload/complete', { key: 'v0.1.3/x.exe', uploadId: 'u', parts: [] }))).status).toBe(400)
    expect((await run(w, post('/admin/upload/complete', { key: 'v0.1.3/x.exe', uploadId: 'u', parts: [{ partNumber: 'one', etag: 1 }] }))).status).toBe(400)
    expect((await run(w, req('/admin/upload/start', { method: 'POST', body: '{', headers: auth }))).status).toBe(400)
  })
  it('abort marks the upload aborted', async () => {
    const w = world({ admin: true })
    const key = 'v0.1.3/Reel-Studio-Setup-0.1.3-x64.exe'
    const start = (await (await run(w, post('/admin/upload/start', { key }))).json()) as { uploadId: string }
    expect((await run(w, post('/admin/upload/abort', { key, uploadId: start.uploadId }))).status).toBe(200)
    expect(w.r2.multipart.get(start.uploadId)?.aborted).toBe(true)
  })
  it('delete removes one object by exact key', async () => {
    const w = world({ admin: true })
    expect((await run(w, req('/admin/objects?key=v0.1.2/Reel-Studio-0.1.2-arm64.dmg', { method: 'DELETE', headers: auth }))).status).toBe(200)
    expect(w.r2.objects.has('v0.1.2/Reel-Studio-0.1.2-arm64.dmg')).toBe(false)
    expect((await run(w, req('/admin/objects?key=../x', { method: 'DELETE', headers: auth }))).status).toBe(400)
  })
})

describe('POST /admin/link', () => {
  it('mints working links for a session, saying whether it is on file', async () => {
    const w = world({ admin: true })
    const sid = 'cs_live_supportcase0000000000'
    const res = await run(w, post('/admin/link', { sid, plan: 'monthly' }))
    expect(res.status).toBe(200)
    const b = (await res.json()) as { onFile: boolean; plan: string; win: string; mac: string; token: string }
    expect(b.onFile).toBe(false)
    expect(b.plan).toBe('monthly')
    expect(b.win).toBe(`https://dl.getreelstudio.com/d/${b.token}/Reel-Studio-Setup-0.1.2-x64.exe`)
    // the minted link really downloads
    const dl = await run(w, req(`/d/${b.token}/Reel-Studio-0.1.2-arm64.dmg`))
    expect(dl.status).toBe(200)
    expect(new Uint8Array(await dl.arrayBuffer())).toEqual(new Uint8Array([9, 8, 7]))
    // a recorded purchase keeps its own plan
    await run(w, req(`/api/claim?session_id=${(await import('./fakes')).SID}`))
    const known = (await (await run(w, post('/admin/link', { sid: (await import('./fakes')).SID, plan: 'monthly' }))).json()) as { onFile: boolean; plan: string }
    expect(known).toMatchObject({ onFile: true, plan: 'once' })
    expect((await run(w, post('/admin/link', { sid: 'nope' }))).status).toBe(400)
  })
})

describe('PUT /admin/manifest', () => {
  it('publishes a manifest whose files are in the bucket at the stated size; /latest.json follows', async () => {
    const w = world({ admin: true, manifest: null })
    expect((await run(w, req('/latest.json'))).status).toBe(503)
    const res = await run(w, put('/admin/manifest', JSON.stringify(MANIFEST), { ...auth, 'content-type': 'application/json' }))
    expect(res.status).toBe(200)
    expect(((await res.json()) as { published: { version: string } }).published.version).toBe('0.1.2')
    expect(((await (await run(w, req('/latest.json'))).json()) as { version: string }).version).toBe('0.1.2')
  })
  it('refuses a manifest naming a file that is missing or has another size', async () => {
    const w = world({ admin: true })
    const missing = { ...MANIFEST, files: { win: { ...MANIFEST.files.win, key: 'v0.1.2/nope.exe' } } }
    const r1 = await run(w, put('/admin/manifest', JSON.stringify(missing), auth))
    expect(r1.status).toBe(400)
    expect(JSON.stringify(await r1.json())).toContain('not in the bucket')
    const wrongSize = { ...MANIFEST, files: { win: { ...MANIFEST.files.win, size: 99 } } }
    const r2 = await run(w, put('/admin/manifest', JSON.stringify(wrongSize), auth))
    expect(r2.status).toBe(400)
    expect(JSON.stringify(await r2.json())).toContain('manifest says 99')
    expect((await run(w, put('/admin/manifest', '{"version":"x"}', auth))).status).toBe(400)
    // the old manifest is untouched
    expect(((await (await run(w, req('/latest.json'))).json()) as { version: string }).version).toBe('0.1.2')
  })
})
