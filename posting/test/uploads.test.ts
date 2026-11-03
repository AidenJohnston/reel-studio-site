import { describe, expect, it } from 'vitest'
import { GRAIN, MAX_CHUNK } from '../src/uploads'
import { ORIGIN, body, connected, endSubscription, putChunk, putPurchase, run, startUpload, video, world } from './fakes'

const SIZE = 3 * GRAIN + 1000
const CHUNK = 2 * GRAIN

async function ready(opts: Parameters<typeof world>[0] = {}) {
  const w = world(opts)
  const { session } = await connected(w)
  return { w, session }
}

async function started(size = SIZE, over: Record<string, unknown> = {}) {
  const { w, session } = await ready()
  const res = await startUpload(w, session, size, over)
  expect(res.status).toBe(201)
  const { uploadId } = await body(res)
  return { w, session, uploadId: uploadId as string, bytes: video(size) }
}

const status = async (w: ReturnType<typeof world>, session: string, id: string) => run(w, `/v1/uploads/${id}`, { bearer: session })

describe('POST /v1/uploads: opening the YouTube upload session', () => {
  it('sends Google the metadata and headers, stores the session address encrypted, and no title', async () => {
    const { w, session } = await ready()
    const res = await startUpload(w, session, SIZE, { title: '  How I got my first job  ', privacy: 'unlisted', madeForKids: true })
    expect(res.status).toBe(201)
    const b = await body(res)
    expect(b).toEqual({ uploadId: expect.stringMatching(/^u_[0-9a-f]{32}$/), status: 'uploading', size: SIZE, received: 0, chunkSize: 8388608 })
    const g = w.google.state.uploads.get('u1')!
    expect(g.size).toBe(SIZE)
    expect(g.mime).toBe('video/mp4')
    expect(g.metadata).toEqual({
      snippet: { title: 'How I got my first job', description: 'A short one.', categoryId: '22' },
      status: { privacyStatus: 'unlisted', selfDeclaredMadeForKids: true }
    })
    const row = w.db.rows<Record<string, unknown>>('uploads')[0]
    expect(row).toMatchObject({ status: 'uploading', size: SIZE, received: 0, privacy_requested: 'unlisted' })
    expect(String(row.session_uri_enc)).toMatch(/^k1\./)
    const dump = JSON.stringify(w.db.rows('uploads'))
    expect(dump).not.toContain('upload_id=')
    expect(dump).not.toContain('first job')
    expect(dump).not.toContain('A short one')
  })

  it('validates every field', async () => {
    const { w, session } = await ready()
    const bad = async (over: Record<string, unknown>, field?: string) => {
      const res = await startUpload(w, session, SIZE, over)
      expect(res.status).toBe(400)
      expect(await body(res)).toEqual(field ? { error: 'bad_request', field } : { error: 'bad_request' })
    }
    await bad({ size: 0 }, 'size')
    await bad({ size: 1.5 }, 'size')
    await bad({ size: 4 * 1024 ** 3 + 1 }, 'size')
    await bad({ title: '   ' }, 'title')
    await bad({ title: 'x'.repeat(101) }, 'title')
    await bad({ title: 'a <b> title' }, 'title')
    await bad({ description: 'é'.repeat(2501) }, 'description')
    await bad({ description: 'no > please' }, 'description')
    await bad({ privacy: 'friends' }, 'privacy')
    await bad({ mimeType: 'image/png' })
    await bad({ platform: 'tiktok' })
    await bad({ madeForKids: 'no' })
    // 100 characters, and a 5,000-byte description, are fine.
    expect((await startUpload(w, session, SIZE, { title: '🎬'.repeat(100), description: 'é'.repeat(2500) })).status).toBe(201)
    expect(w.google.state.uploads.size).toBe(1)
  })

  it('409 not_connected without a connection, reconnect_needed after invalid_grant', async () => {
    const w = world()
    const { signIn } = await import('./fakes')
    const s = await signIn(w)
    expect(await body(await startUpload(w, s, SIZE))).toEqual({ error: 'not_connected' })

    const r = await ready()
    r.w.google.revokeAll()
    r.w.now += 3600_000 // the cached access token has expired, so a refresh is needed
    const res = await startUpload(r.w, r.session, SIZE)
    expect(res.status).toBe(409)
    expect(await body(res)).toEqual({ error: 'reconnect_needed' })
    const conn = r.w.db.rows<Record<string, unknown>>('connections')[0]
    expect(conn).toMatchObject({ status: 'reconnect', refresh_enc: null, access_enc: null, channel_id: null, channel_name: null, channel_handle: null })
    expect((await body(await run(r.w, '/v1/me', { bearer: r.session }))).connections[0]).toMatchObject({ status: 'reconnect', channelName: null })
    // And from then on without asking Google.
    const calls = r.w.google.state.calls.length
    expect(await body(await startUpload(r.w, r.session, SIZE))).toEqual({ error: 'reconnect_needed' })
    expect(r.w.google.state.calls.length).toBe(calls)
  })

  it('refreshes the access token when under 5 minutes are left, and caches it encrypted', async () => {
    const { w, session } = await ready()
    w.now += 3599_000 - 4 * 60_000
    expect((await startUpload(w, session, SIZE)).status).toBe(201)
    expect(w.google.state.calls.filter((c) => c === 'POST /token grant_type=refresh_token')).toHaveLength(1)
    w.now += 60_000
    expect((await startUpload(w, session, SIZE)).status).toBe(201)
    expect(w.google.state.calls.filter((c) => c === 'POST /token grant_type=refresh_token')).toHaveLength(1)
  })

  it('401 from Google → refresh once and try again', async () => {
    const { w, session } = await ready()
    w.google.state.faults.push({ on: 'init', status: 401, reason: 'authError' })
    expect((await startUpload(w, session, SIZE)).status).toBe(201)
    expect(w.google.state.calls.filter((c) => c === 'POST /upload init')).toHaveLength(2)
    expect(w.google.state.calls).toContain('POST /token grant_type=refresh_token')
  })

  it('quota (the project) and upload limit (the channel) are 429s with Retry-After', async () => {
    const { w, session } = await ready()
    w.google.state.quotaExceeded = true
    const q = await startUpload(w, session, SIZE)
    expect(q.status).toBe(429)
    expect(await body(q)).toEqual({ error: 'quota' })
    expect(Number(q.headers.get('retry-after'))).toBe(20 * 3600) // 12:00 UTC → 08:00 UTC tomorrow
    w.google.state.quotaExceeded = false
    w.google.state.uploadLimitExceeded = true
    const u = await startUpload(w, session, SIZE)
    expect(u.status).toBe(429)
    expect(await body(u)).toEqual({ error: 'upload_limit' })
    expect(w.db.rows('uploads')).toHaveLength(0)
  })

  it('YouTube refusing a field, no channel, 5xx and the unexpected', async () => {
    const { w, session } = await ready()
    const cases: Array<[{ status: number; reason: string }, number, unknown]> = [
      [{ status: 400, reason: 'invalidTitle' }, 400, { error: 'bad_request', field: 'title' }],
      [{ status: 400, reason: 'invalidDescription' }, 400, { error: 'bad_request', field: 'description' }],
      [{ status: 403, reason: 'forbiddenPrivacySetting' }, 400, { error: 'bad_request', field: 'privacy' }],
      [{ status: 401, reason: 'youtubeSignupRequired' }, 409, { error: 'no_channel' }],
      [{ status: 503, reason: 'backendError' }, 502, { error: 'platform_error', retry: true }],
      [{ status: 400, reason: 'somethingNew' }, 502, { error: 'platform_error', retry: false }]
    ]
    for (const [fault, code, answer] of cases) {
      w.google.state.faults.push({ on: 'init', ...fault })
      const res = await startUpload(w, session, SIZE)
      expect(res.status).toBe(code)
      expect(await body(res)).toEqual(answer)
    }
  })

  it('refuses a session address that is not Google’s (or the configured fake’s)', async () => {
    const { w, session } = await ready()
    const real = w.google.fetch
    w.deps = () => ({
      now: () => w.now,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await real(input, init)
        if (res.headers.get('location')?.includes('upload_id=')) return new Response(null, { status: 200, headers: { Location: 'https://evil.example/upload?upload_id=x' } })
        return res
      }) as typeof fetch
    })
    const res = await startUpload(w, session, SIZE)
    expect(await body(res)).toEqual({ error: 'platform_error', retry: false })
    expect(w.db.rows('uploads')).toHaveLength(0)
  })

  it('limits uploads to 30 a day per purchase', async () => {
    const { w, session } = await ready()
    for (let i = 0; i < 30; i++) expect((await startUpload(w, session, 1000)).status).toBe(201)
    const res = await startUpload(w, session, 1000)
    expect(res.status).toBe(429)
    expect(await body(res)).toEqual({ error: 'rate_limited' })
  })
})

describe('PUT /v1/uploads/:id: chunks forwarded to Google', () => {
  it('sends the whole video in chunks; the last one answers the video with what YouTube set', async () => {
    const { w, session, uploadId, bytes } = await started()
    let received = 0
    let last: Record<string, any> = {}
    while (received < SIZE) {
      const res = await putChunk(w, session, uploadId, bytes.slice(received, Math.min(received + CHUNK, SIZE)), received, SIZE)
      expect(res.status).toBe(200)
      last = await body(res)
      received = last.received
    }
    expect(last).toEqual({
      uploadId,
      status: 'done',
      size: SIZE,
      received: SIZE,
      video: {
        id: 'v0000000001',
        url: 'https://www.youtube.com/watch?v=v0000000001',
        studioUrl: 'https://studio.youtube.com/video/v0000000001/edit',
        privacy: 'private',
        channelName: 'Fake Channel'
      }
    })
    expect(w.google.state.uploads.get('u1')!.bytes).toEqual(bytes)
    expect(w.google.state.calls.filter((c) => c.startsWith('PUT upload u1 bytes'))).toEqual([
      `PUT upload u1 bytes 0-${CHUNK - 1}/${SIZE}`,
      `PUT upload u1 bytes ${CHUNK}-${SIZE - 1}/${SIZE}`
    ])
    const row = w.db.rows<Record<string, unknown>>('uploads')[0]
    expect(row).toMatchObject({ status: 'done', received: SIZE, video_id: 'v0000000001', privacy: 'private', session_uri_enc: null })
    // GET answers the same, and a further chunk is refused.
    expect(await body(await status(w, session, uploadId))).toEqual(last)
    const again = await putChunk(w, session, uploadId, bytes.slice(0, GRAIN), 0, SIZE)
    expect(again.status).toBe(409)
    expect(await body(again)).toEqual({ error: 'upload_finished', status: 'done' })
  })

  it('reports the privacy YouTube actually set when it differs from what was asked', async () => {
    const { w, session, uploadId, bytes } = await started(1000, { privacy: 'public' })
    const real = w.google.fetch
    w.deps = () => ({
      now: () => w.now,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await real(input, init)
        if (res.status !== 201) return res
        const v = (await res.json()) as Record<string, any>
        return new Response(JSON.stringify({ ...v, status: { ...v.status, privacyStatus: 'private' } }), { status: 201 })
      }) as typeof fetch
    })
    const done = await body(await putChunk(w, session, uploadId, bytes, 0, 1000))
    expect(done.video.privacy).toBe('private')
    expect(w.db.rows<{ privacy_requested: string; privacy: string }>('uploads')[0]).toMatchObject({ privacy_requested: 'public', privacy: 'private' })
  })

  it('resumes after an interrupted chunk: 502 retry, GET finds what Google kept, the app goes on from there', async () => {
    const { w, session, uploadId, bytes } = await started()
    // The connection drops after Google stored 300,000 bytes of the first chunk (it keeps whole 256 KiB units).
    w.google.state.faults.push({ on: 'chunk', dropAfterBytes: 300_000 })
    const dropped = await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(dropped.status).toBe(502)
    expect(await body(dropped)).toEqual({ error: 'platform_error', retry: true })
    expect(w.db.rows<{ status: string; received: number }>('uploads')[0]).toMatchObject({ status: 'uploading', received: 0 })

    const s = await status(w, session, uploadId)
    expect(await body(s)).toEqual({ uploadId, status: 'uploading', size: SIZE, received: GRAIN })

    let received = GRAIN
    let last: Record<string, any> = {}
    while (received < SIZE) {
      last = await body(await putChunk(w, session, uploadId, bytes.slice(received, Math.min(received + CHUNK, SIZE)), received, SIZE))
      received = last.received
    }
    expect(last.status).toBe('done')
    expect(w.google.state.uploads.get('u1')!.bytes).toEqual(bytes)
  })

  it('a stale retry from the old offset after a drop is told where to continue (409 offset_mismatch), not failed', async () => {
    const { w, session, uploadId, bytes } = await started()
    w.google.state.faults.push({ on: 'chunk', dropAfterBytes: GRAIN })
    expect((await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)).status).toBe(502)
    // The app retries the same chunk without asking first. Google has GRAIN bytes, so it refuses the start.
    const retry = await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(retry.status).toBe(409)
    expect(await body(retry)).toEqual({ error: 'offset_mismatch', received: GRAIN })
    expect(w.db.rows<{ status: string }>('uploads')[0].status).toBe('uploading')
  })

  it('a 308 that confirms less than was sent: received is what Google confirmed', async () => {
    const { w, session, uploadId, bytes } = await started()
    const real = w.google.fetch
    w.deps = () => ({
      now: () => w.now,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await real(input, init)
        if (res.status === 308 && res.headers.get('range') === `bytes=0-${CHUNK - 1}`) return new Response(null, { status: 308, headers: { Range: `bytes=0-${GRAIN - 1}` } })
        return res
      }) as typeof fetch
    })
    const res = await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(await body(res)).toEqual({ uploadId, status: 'uploading', size: SIZE, received: GRAIN })
  })

  it('a chunk that does not start at the confirmed offset: 409 offset_mismatch, Google not called', async () => {
    const { w, session, uploadId, bytes } = await started()
    const calls = w.google.state.calls.length
    const res = await putChunk(w, session, uploadId, bytes.slice(GRAIN, CHUNK + GRAIN), GRAIN, SIZE)
    expect(res.status).toBe(409)
    expect(await body(res)).toEqual({ error: 'offset_mismatch', received: 0 })
    expect(w.google.state.calls.length).toBe(calls)
  })

  it('Content-Range rules: total, length, the 256 KiB multiple, and the 16 MiB cap', async () => {
    const { w, session, uploadId, bytes } = await started()
    const bad = async (res: Response, status = 400) => {
      expect(res.status).toBe(status)
      return body(res)
    }
    // Not a multiple of 256 KiB and not the last chunk.
    expect(await bad(await putChunk(w, session, uploadId, bytes.slice(0, GRAIN + 1), 0, SIZE))).toEqual({ error: 'bad_request', field: 'content_range' })
    // Another total.
    expect(await bad(await putChunk(w, session, uploadId, bytes.slice(0, GRAIN), 0, SIZE + 1))).toEqual({ error: 'bad_request', field: 'content_range' })
    // A body shorter than the range says.
    const short = await run(w, `/v1/uploads/${uploadId}`, { method: 'PUT', bearer: session, headers: { 'content-range': `bytes 0-${GRAIN - 1}/${SIZE}` }, body: bytes.slice(0, 1000) })
    expect(await bad(short)).toEqual({ error: 'bad_request', field: 'content_range' })
    // No or garbled header.
    expect(await bad(await run(w, `/v1/uploads/${uploadId}`, { method: 'PUT', bearer: session, body: bytes.slice(0, GRAIN) }))).toEqual({ error: 'bad_request', field: 'content_range' })
    // Over 16 MiB (a bigger upload so the range is valid).
    const big = await startUpload(w, session, 40 * 1024 * 1024)
    const bigId = (await body(big)).uploadId
    const huge = await run(w, `/v1/uploads/${bigId}`, { method: 'PUT', bearer: session, headers: { 'content-range': `bytes 0-${MAX_CHUNK + GRAIN - 1}/${40 * 1024 * 1024}` }, body: new Uint8Array(10) })
    expect(await bad(huge, 413)).toEqual({ error: 'chunk_too_large', max: MAX_CHUNK })
    expect(w.google.state.calls.some((c) => c.startsWith('PUT upload'))).toBe(false)
  })

  it('a final chunk shorter than 256 KiB is fine', async () => {
    const { w, session, uploadId, bytes } = await started(GRAIN + 10)
    expect((await body(await putChunk(w, session, uploadId, bytes.slice(0, GRAIN), 0, GRAIN + 10))).received).toBe(GRAIN)
    expect((await body(await putChunk(w, session, uploadId, bytes.slice(GRAIN), GRAIN, GRAIN + 10))).status).toBe('done')
  })

  it('401 from Google → refresh the access token once and resend the same chunk', async () => {
    const { w, session, uploadId, bytes } = await started()
    // The access token dies at Google (its hour is up early, say).
    w.google.state.accessTokens.clear()
    const res = await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(res.status).toBe(200)
    expect((await body(res)).received).toBe(CHUNK)
    expect(w.google.state.calls.filter((c) => c.startsWith('PUT upload u1'))).toEqual(['PUT upload u1 (unauthorized)', `PUT upload u1 bytes 0-${CHUNK - 1}/${SIZE}`])
  })

  it('invalid_grant during an upload → 409 reconnect_needed', async () => {
    const { w, session, uploadId, bytes } = await started()
    w.google.revokeAll()
    const res = await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(res.status).toBe(409)
    expect(await body(res)).toEqual({ error: 'reconnect_needed' })
  })

  it('Google 5xx → 502 retry:true, the upload stays open', async () => {
    const { w, session, uploadId, bytes } = await started()
    w.google.state.faults.push({ on: 'chunk', status: 503 })
    const res = await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(await body(res)).toEqual({ error: 'platform_error', retry: true })
    expect((await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)).status).toBe(200)
  })

  it('Google 404 (the session expired) → 410 upload_expired', async () => {
    const { w, session, uploadId, bytes } = await started()
    w.google.expireUpload('u1')
    const res = await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(res.status).toBe(410)
    expect(await body(res)).toEqual({ error: 'upload_expired' })
    expect(w.db.rows<Record<string, unknown>>('uploads')[0]).toMatchObject({ status: 'expired', session_uri_enc: null })
    expect(await body(await status(w, session, uploadId))).toEqual({ uploadId, status: 'expired', size: SIZE, received: 0 })
  })

  it('upload limit hit mid-upload: failed, 429 upload_limit', async () => {
    const { w, session, uploadId, bytes } = await started()
    w.google.state.faults.push({ on: 'chunk', status: 400, reason: 'uploadLimitExceeded' })
    const res = await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(res.status).toBe(429)
    expect(await body(res)).toEqual({ error: 'upload_limit' })
    expect(await body(await status(w, session, uploadId))).toEqual({ uploadId, status: 'failed', size: SIZE, received: 0, error: 'uploadLimitExceeded' })
  })

  it('works for any later session of the same purchase (after sign out everywhere)', async () => {
    const { w, session, uploadId, bytes } = await started()
    await run(w, '/v1/sessions', { method: 'DELETE', bearer: session })
    const { signIn } = await import('./fakes')
    const again = await signIn(w)
    expect((await putChunk(w, again, uploadId, bytes.slice(0, CHUNK), 0, SIZE)).status).toBe(200)
  })

  it('stops when the subscription ends', async () => {
    const { w, session, uploadId, bytes } = await started()
    endSubscription(w)
    expect((await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)).status).toBe(403)
  })
})

describe('GET and DELETE /v1/uploads/:id', () => {
  it('GET asks Google: nothing yet, then what arrived', async () => {
    const { w, session, uploadId, bytes } = await started()
    expect(await body(await status(w, session, uploadId))).toEqual({ uploadId, status: 'uploading', size: SIZE, received: 0 })
    await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE)
    expect(await body(await status(w, session, uploadId))).toEqual({ uploadId, status: 'uploading', size: SIZE, received: CHUNK })
    expect(w.google.state.calls.filter((c) => c === 'PUT upload u1 status')).toHaveLength(2)
  })

  it('GET finds an upload Google finished while our answer was lost', async () => {
    const { w, session, uploadId, bytes } = await started(1000)
    // Google got it all, but the answer never reached us.
    const real = w.google.fetch
    let lose = true
    w.deps = () => ({
      now: () => w.now,
      fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const res = await real(input, init)
        if (lose && res.status === 201) {
          lose = false
          throw new TypeError('network')
        }
        return res
      }) as typeof fetch
    })
    expect(await body(await putChunk(w, session, uploadId, bytes, 0, 1000))).toEqual({ error: 'platform_error', retry: true })
    const s = await body(await status(w, session, uploadId))
    expect(s.status).toBe('done')
    expect(s.video.id).toBe('v0000000001')
  })

  it('GET with Google down → 502 retry:true', async () => {
    const { w, session, uploadId } = await started()
    w.google.state.faults.push({ on: 'status', status: 500 })
    expect(await body(await status(w, session, uploadId))).toEqual({ error: 'platform_error', retry: true })
  })

  it('DELETE cancels without calling Google and wipes the session address', async () => {
    const { w, session, uploadId, bytes } = await started()
    const calls = w.google.state.calls.length
    expect(await body(await run(w, `/v1/uploads/${uploadId}`, { method: 'DELETE', bearer: session }))).toEqual({ ok: true })
    expect(w.google.state.calls.length).toBe(calls)
    expect(w.db.rows<Record<string, unknown>>('uploads')[0]).toMatchObject({ status: 'cancelled', session_uri_enc: null })
    expect(await body(await status(w, session, uploadId))).toEqual({ uploadId, status: 'cancelled', size: SIZE, received: 0 })
    expect(await body(await putChunk(w, session, uploadId, bytes.slice(0, CHUNK), 0, SIZE))).toEqual({ error: 'upload_finished', status: 'cancelled' })
  })

  it("another purchase's upload is 404", async () => {
    const { w, uploadId } = await started()
    putPurchase(w, { sid: 'cs_test_someone_else_000000000000000000000000' })
    const { mintToken } = await import('../../worker/src/token')
    const { SECRET } = await import('./fakes')
    const key = await mintToken(SECRET, { s: 'cs_test_someone_else_000000000000000000000000', p: 'monthly', e: 9e9 })
    const res = await run(w, '/v1/sessions', { method: 'POST', bearer: key, json: { device: 'Mac' } })
    const other = (await body(res)).session
    expect((await status(w, other, uploadId)).status).toBe(404)
    expect((await run(w, `/v1/uploads/${uploadId}`, { method: 'DELETE', bearer: other })).status).toBe(404)
    expect((await putChunk(w, other, uploadId, new Uint8Array(GRAIN), 0, SIZE)).status).toBe(404)
    expect((await status(w, other, 'u_nothex')).status).toBe(404)
  })
})

it('the base URL in every test is the staging origin', () => {
  expect(ORIGIN).toBe('https://post-staging.getreelstudio.com')
})
