// LOCAL ONLY: writes a test purchase into the local PURCHASES KV of `npm run dev` and prints a purchase key for
// it, minted with posting/.dev.vars' TOKEN_SECRET. Paste the key into the app (REELSTUDIO_POSTING_URL pointing
// at the local Worker) to sign in. It never touches a remote namespace: the KV write is `--local`.
//
//   node tools/dev-seed.mjs [--plan monthly|once]
import { spawnSync } from 'node:child_process'
import { createHmac } from 'node:crypto'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** npx needs a shell on Windows, which joins the arguments as they are: quote the ones with spaces. */
const shellArgs = (list) => (process.platform === 'win32' ? list.map((a) => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)) : list)

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const plan = args.includes('--plan') ? args[args.indexOf('--plan') + 1] : 'monthly'
if (plan !== 'monthly' && plan !== 'once') throw new Error('--plan is monthly or once')

const vars = Object.fromEntries(
  readFileSync(join(root, '.dev.vars'), 'utf8')
    .replace(/\r/g, '')
    .split('\n')
    .filter((l) => /^[A-Z_]+=/.test(l))
    .map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1).trim()])
)
const secret = vars.TOKEN_SECRET
if (!secret || secret.length < 16) throw new Error('posting/.dev.vars needs TOKEN_SECRET (32+ characters)')

const sid = `cs_test_local_posting_${plan}`
const now = Date.now()
const purchase = { sid, plan, emailHash: null, customer: null, subscription: null, paymentIntent: null, created: Math.floor(now / 1000), recordedAt: now, source: 'claim' }

mkdirSync(join(root, '.wrangler'), { recursive: true })
const file = join(root, '.wrangler', 'dev-seed-purchase.json')
writeFileSync(file, JSON.stringify(purchase))
const r = spawnSync('npx', shellArgs(['wrangler', 'kv', 'key', 'put', `sess:${sid}`, '--path', file, '--binding', 'PURCHASES', '--local']), { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' })
if (r.status !== 0) process.exit(r.status ?? 1)

// The same format as the downloads Worker's mintToken (worker/src/token.ts).
const b64url = (buf) => Buffer.from(buf).toString('base64url')
const body = b64url(JSON.stringify({ s: sid, p: plan, e: Math.floor(now / 1000) + 400 * 86400 }))
const sig = b64url(createHmac('sha256', secret).update(`v1.${body}`).digest())
console.log(`\nLocal test purchase ${sid} written. Its key (local only):\n\nv1.${body}.${sig}\n`)
