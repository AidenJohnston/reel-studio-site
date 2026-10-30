import { describe, expect, it } from 'vitest'
import { handle } from '../src/app'
import { linkEmail } from '../src/email'
import { SID, T0, deps, paidSession, req, signed, world } from './fakes'

const run = (w: ReturnType<typeof world>, r: Request) => handle(r, w.env, w.ctx, deps(w))
const event = (session: Record<string, unknown>) => JSON.stringify({ id: 'evt_1', type: 'checkout.session.completed', data: { object: session } })
type Mail = { to: string; subject: string; text: string; html: string }

describe('the receipt email from the webhook', () => {
  it('a paid session gets one email with working links, and the record remembers it', async () => {
    const w = world({ email: true })
    expect((await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000)))).status).toBe(200)
    await Promise.all(w.waited)
    expect(w.emails.length).toBe(1)
    const m = w.emails[0] as Mail
    expect(m.to).toBe('buyer@example.com')
    expect(m.subject).toBe('Your Reel Studio download')
    expect(m.text).toContain('Thanks for buying Reel Studio')
    expect(m.text).toContain('receipt comes separately from Stripe')
    const link = /https:\/\/dl\.getreelstudio\.com\/d\/(v1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)\/Reel-Studio-0\.1\.2-arm64\.dmg/.exec(m.text)
    expect(link).not.toBeNull()
    const dl = await run(w, req(`/d/${link![1]}/Reel-Studio-0.1.2-arm64.dmg`))
    expect(dl.status).toBe(200)
    const rec = JSON.parse(w.kv.store.get(`sess:${SID}`)!)
    expect(typeof rec.receiptAt).toBe('number')
  })
  it('a retried webhook does not send twice', async () => {
    const w = world({ email: true })
    await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000)))
    await Promise.all(w.waited)
    await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000) + 5))
    await Promise.all(w.waited)
    expect(w.emails.length).toBe(1)
  })
  it('a session the thanks page claimed first still gets its receipt once', async () => {
    const w = world({ email: true })
    await run(w, req(`/api/claim?session_id=${SID}`))
    await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000)))
    await Promise.all(w.waited)
    expect(w.emails.length).toBe(1)
  })
  it('monthly wording; no email address → no email, but still recorded', async () => {
    const w = world({ email: true })
    await run(w, await signed(event(paidSession({ mode: 'subscription' })), Math.floor(T0 / 1000)))
    await Promise.all(w.waited)
    expect((w.emails[0] as Mail).text).toContain('Thanks for subscribing')
    const w2 = world({ email: true })
    await run(w2, await signed(event(paidSession({ customer_details: null, customer_email: null })), Math.floor(T0 / 1000)))
    await Promise.all(w2.waited)
    expect(w2.emails.length).toBe(0)
    expect(w2.kv.store.has(`sess:${SID}`)).toBe(true)
  })
  it('without Email Sending nothing is sent and the webhook still answers 200', async () => {
    const w = world()
    expect((await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000)))).status).toBe(200)
    expect(w.waited.length).toBe(0)
  })
  it('a failing mail service is logged, not thrown, and the receipt stays unsent for a retry', async () => {
    const w = world({ email: true })
    ;(w.env.EMAIL as unknown as { send: () => Promise<never> }).send = async () => {
      throw Object.assign(new Error('quota'), { code: 'E_RATE_LIMIT_EXCEEDED' })
    }
    expect((await run(w, await signed(event(paidSession()), Math.floor(T0 / 1000)))).status).toBe(200)
    await Promise.all(w.waited)
    expect(JSON.parse(w.kv.store.get(`sess:${SID}`)!).receiptAt).toBeUndefined()
  })
})

describe('the resend email', () => {
  it('says it is the link the buyer asked for, with both platforms', () => {
    const m = linkEmail({ reason: 'resend', plan: 'once', version: '0.1.3', win: { name: 'w.exe', url: 'https://dl/w' }, mac: { name: 'm.dmg', url: 'https://dl/m' }, siteOrigin: 'https://getreelstudio.com', supportEmail: 'support@getreelstudio.com' })
    expect(m.subject).toBe('Your Reel Studio 0.1.3 download link')
    expect(m.text).toContain('Here is your download link for Reel Studio 0.1.3')
    expect(m.text).toContain('https://dl/w')
    expect(m.html).toContain('Download for Mac')
    expect(m.html).not.toContain('<script')
  })
})
