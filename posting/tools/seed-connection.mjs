// Seeds a YouTube connection from a refresh token obtained outside the Worker (a one-off sign-in), so a staging
// upload can be proven before anyone has clicked Connect YouTube in the app. It encrypts the token with the
// Worker's own code (src/crypto.ts) under the environment's ENC_KEY and writes the row with `wrangler d1 execute`.
// Any earlier YouTube connection of that purchase (and its upload rows) is replaced; it is not revoked.
//
//   node tools/seed-connection.mjs --env staging --key-file <purchase key> --token-file <env file> --enc-key-file <env file>
//
// --token-file holds YOUTUBE_REFRESH_TOKEN, YOUTUBE_CHANNEL_ID and optionally YOUTUBE_SCOPES; --enc-key-file holds
// ENC_KEY (the same value as the Worker's secret). Nothing secret is printed; the SQL file holds only the
// encrypted token and is deleted afterwards.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ad, encrypt, importEncKey, newId } from '../src/crypto.ts'

/** npx needs a shell on Windows, which joins the arguments as they are: quote the ones with spaces. */
const shellArgs = (list) => (process.platform === 'win32' ? list.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : list)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const opt = (name) => {
  const i = args.indexOf(name)
  if (i < 0 || !args[i + 1]) throw new Error(`${name} is required`)
  return args[i + 1]
}
const envName = opt('--env')
if (envName !== 'staging') throw new Error('only --env staging is supported')

const readEnv = (file) =>
  Object.fromEntries(
    readFileSync(file, 'utf8')
      .replace(/\r/g, '')
      .split('\n')
      .filter((l) => /^[A-Z_]+=/.test(l))
      .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
  )

const key = readFileSync(opt('--key-file'), 'utf8').replace(/\s+/g, '')
const claims = JSON.parse(Buffer.from(key.split('.')[1] ?? '', 'base64url').toString('utf8'))
if (typeof claims?.s !== 'string' || !claims.s) throw new Error('the key file does not hold a purchase key')
const sid = claims.s

const tokens = readEnv(opt('--token-file'))
const refresh = tokens.YOUTUBE_REFRESH_TOKEN
const channelId = tokens.YOUTUBE_CHANNEL_ID || null
const scopes = tokens.YOUTUBE_SCOPES || 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly'
if (!refresh) throw new Error('YOUTUBE_REFRESH_TOKEN missing')
if (!scopes.split(/\s+/).includes('https://www.googleapis.com/auth/youtube.upload')) throw new Error('the token was not granted youtube.upload')

const encKey = await importEncKey(readEnv(opt('--enc-key-file')).ENC_KEY)
if (!encKey) throw new Error('ENC_KEY missing or not 32 bytes')

const id = newId('c')
const now = Date.now()
const q = (v) => (v === null ? 'NULL' : `'${String(v).replace(/'/g, "''")}'`)
const sql = [
  `DELETE FROM uploads WHERE connection_id IN (SELECT id FROM connections WHERE sid = ${q(sid)} AND platform = 'youtube');`,
  `DELETE FROM connections WHERE sid = ${q(sid)} AND platform = 'youtube';`,
  // channel_checked_at NULL: the daily cron reads the channel's name on its next run.
  `INSERT INTO connections (id, sid, platform, status, scopes, channel_id, channel_name, channel_handle, channel_checked_at, refresh_enc, access_enc, access_expires_at, created_at, updated_at) VALUES (${q(id)}, ${q(sid)}, 'youtube', 'connected', ${q(scopes)}, ${q(channelId)}, NULL, NULL, NULL, ${q(await encrypt(encKey, refresh, ad.refresh(id)))}, NULL, NULL, ${now}, ${now});`
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'posting-seed-'))
const file = join(dir, 'seed.sql')
try {
  writeFileSync(file, sql, { mode: 0o600 })
  const r = spawnSync('npx', shellArgs(['wrangler', 'd1', 'execute', 'DB', '--env', envName, '--remote', '--file', file]), { cwd: root, encoding: 'utf8', shell: process.platform === 'win32' })
  if (r.status !== 0) {
    console.error((r.stderr || r.stdout || '').slice(-2000))
    process.exit(r.status ?? 1)
  }
} finally {
  rmSync(dir, { recursive: true, force: true })
}
console.log(`Seeded YouTube connection ${id.slice(0, 10)}… for purchase ${sid.slice(0, 10)}…${sid.slice(-4)} on ${envName}.`)
