import { describe, expect, it } from 'vitest'
import worker from '../src/index'
import { body, run, signIn, world } from './fakes'

describe('routes', () => {
  it('GET /v1/health needs no auth', async () => {
    const w = world()
    const res = await run(w, '/v1/health')
    expect(res.status).toBe(200)
    expect(await body(res)).toEqual({ ok: true, youtube: true })
    expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('GET / sends people to the site', async () => {
    const res = await run(world(), '/')
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe('https://getreelstudio.com/')
  })

  it('unknown routes are 404 not_found (401 first under /v1/ without a session)', async () => {
    const w = world()
    expect(await body(await run(w, '/nope'))).toEqual({ error: 'not_found' })
    expect((await run(w, '/oauth/youtube/callback')).status).toBe(404)
    expect((await run(w, '/v1/nope')).status).toBe(401)
    const s = await signIn(w)
    const res = await run(w, '/v1/nope', { bearer: s })
    expect(res.status).toBe(404)
    expect(await body(res)).toEqual({ error: 'not_found' })
    expect((await run(w, '/v1/me', { method: 'POST', bearer: s })).status).toBe(404)
  })

  it('no CORS headers, ever', async () => {
    const w = world()
    const res = await run(w, '/v1/health', { headers: { origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBeNull()
  })

  it('503 not_configured db without the D1 binding', async () => {
    const w = world({ env: { DB: undefined as unknown as D1Database } })
    const res = await run(w, '/v1/me', { bearer: 'ps1_x' })
    expect(res.status).toBe(503)
    expect(await body(res)).toEqual({ error: 'not_configured', what: 'db' })
  })

  it('anything thrown is a 500 server_error, logged without the request body', async () => {
    const w = world()
    const s = await signIn(w)
    ;(w.env as { DB: unknown }).DB = {
      prepare: () => {
        throw new Error('db exploded')
      }
    }
    const res = await run(w, '/v1/me', { bearer: s })
    expect(res.status).toBe(500)
    expect(await body(res)).toEqual({ error: 'server_error' })
  })

  it('the entry exports fetch and scheduled only', () => {
    expect(Object.keys(worker).sort()).toEqual(['fetch', 'scheduled'])
  })
})
