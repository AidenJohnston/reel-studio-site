import { describe, expect, it } from 'vitest'
import { b64url } from '../../worker/src/token'
import { ad, decrypt, encrypt, importEncKey, newId, pkceChallenge, randomToken } from '../src/crypto'
import { ENC_KEY } from './fakes'

describe('tokens at rest (AES-256-GCM)', () => {
  it('round-trips, as k1.<iv>.<ciphertext>, with a fresh iv every time', async () => {
    const key = (await importEncKey(ENC_KEY))!
    const a = await encrypt(key, '1//refresh-token-value', ad.refresh('c_1'))
    const b = await encrypt(key, '1//refresh-token-value', ad.refresh('c_1'))
    expect(a).toMatch(/^k1\.[A-Za-z0-9_-]{16}\.[A-Za-z0-9_-]+$/)
    expect(a).not.toBe(b)
    expect(a).not.toContain('refresh-token-value')
    expect(await decrypt(key, a, ad.refresh('c_1'))).toBe('1//refresh-token-value')
  })

  it('fails with the wrong associated data: a value copied to another row or column does not decrypt', async () => {
    const key = (await importEncKey(ENC_KEY))!
    const v = await encrypt(key, 'secret', ad.refresh('c_1'))
    await expect(decrypt(key, v, ad.refresh('c_2'))).rejects.toThrow()
    await expect(decrypt(key, v, ad.access('c_1'))).rejects.toThrow()
    await expect(decrypt(key, v, ad.upload('c_1'))).rejects.toThrow()
  })

  it('fails under another key, or when edited', async () => {
    const key = (await importEncKey(ENC_KEY))!
    const other = (await importEncKey(b64url(new Uint8Array(32).fill(9))))!
    const v = await encrypt(key, 'secret', 'conn:c_1')
    await expect(decrypt(other, v, 'conn:c_1')).rejects.toThrow()
    const [k, iv, ct] = v.split('.')
    const flipped = ct.slice(0, -2) + (ct.at(-2) === 'A' ? 'B' : 'A') + ct.at(-1)
    await expect(decrypt(key, `${k}.${iv}.${flipped}`, 'conn:c_1')).rejects.toThrow()
    await expect(decrypt(key, 'not-encrypted', 'conn:c_1')).rejects.toThrow()
  })

  it('refuses an ENC_KEY that is missing or not 32 bytes', async () => {
    expect(await importEncKey(undefined)).toBeNull()
    expect(await importEncKey('')).toBeNull()
    expect(await importEncKey(b64url(new Uint8Array(16)))).toBeNull()
    expect(await importEncKey('not base64url!')).toBeNull()
  })
})

describe('ids and PKCE', () => {
  it('makes the contract shapes', () => {
    expect(newId('s')).toMatch(/^s_[0-9a-f]{32}$/)
    expect(newId('u')).toMatch(/^u_[0-9a-f]{32}$/)
    expect(randomToken()).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })
  it('S256 matches RFC 7636 appendix B', async () => {
    expect(await pkceChallenge('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe('E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM')
  })
})
