#!/usr/bin/env node
// Publish Reel Studio installers to the download server (src/admin.ts). Node 20+, no dependencies.
//
//   DOWNLOADS_ADMIN_SECRET=… node tools/publish.mjs list
//   DOWNLOADS_ADMIN_SECRET=… node tools/publish.mjs upload --key v0.1.3/Reel-Studio-Setup-0.1.3-x64.exe --file "…\Reel Studio Setup 0.1.3.exe"
//   DOWNLOADS_ADMIN_SECRET=… node tools/publish.mjs release --version 0.1.5 --win "…\Reel Studio Setup 0.1.5.exe" --mac "…\Reel Studio 0.1.5.dmg" --mac-zip "…\Reel Studio-0.1.5-arm64-mac.zip" --notes notes-0.1.5.md [--dry-run]
//   DOWNLOADS_ADMIN_SECRET=… node tools/publish.mjs delete --key v0.1.2/Reel-Studio-Setup-0.1.2-x64.exe
//
// `release` hashes the files (SHA-256 for people, SHA-512 for the app's updater), uploads any that are not in
// the bucket yet at the right size (64 MiB parts, each retried), then publishes the manifest; the server
// refuses a manifest whose files are not in the bucket. The update feed (/u/) serves the Windows installer and
// the Mac zip, so a release without --mac-zip has no Mac update. --notes adds this release's notes in front of
// the current ones (newest five kept), which the app's "What's new" reads from latest.json.
// DOWNLOADS_API overrides the server (default https://dl.getreelstudio.com; staging: https://dl-staging.getreelstudio.com).
import { createHash } from 'node:crypto'
import { open, readFile, stat } from 'node:fs/promises'
import { basename } from 'node:path'

const API = (process.env.DOWNLOADS_API || 'https://dl.getreelstudio.com').replace(/\/$/, '')
const SECRET = process.env.DOWNLOADS_ADMIN_SECRET
const PART_SIZE = 64 * 1024 * 1024

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`)
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback
}
const has = (name) => process.argv.includes(`--${name}`)

async function api(method, path, body, headers = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${SECRET}`, ...(body && !(body instanceof Uint8Array) ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: body instanceof Uint8Array ? body : body ? JSON.stringify(body) : undefined
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = { raw: text }
  }
  if (!res.ok) throw new Error(`${method} ${path}: HTTP ${res.status} ${JSON.stringify(json).slice(0, 300)}`)
  return json
}

/** { sha256: hex, sha512: base64 } in one pass over the file. */
async function hashes(file) {
  const h = createHash('sha256')
  const h512 = createHash('sha512')
  const fh = await open(file, 'r')
  try {
    const buf = new Uint8Array(8 * 1024 * 1024)
    for (;;) {
      const { bytesRead } = await fh.read(buf, 0, buf.length, null)
      if (!bytesRead) break
      h.update(buf.subarray(0, bytesRead))
      h512.update(buf.subarray(0, bytesRead))
    }
  } finally {
    await fh.close()
  }
  return { sha256: h.digest('hex'), sha512: h512.digest('base64') }
}

/** The notes on the live server now (newest first), so a release adds to them instead of replacing them. */
async function currentNotes() {
  try {
    const res = await fetch(`${API}/latest.json`, { headers: { 'Cache-Control': 'no-cache' } })
    if (!res.ok) return []
    const j = await res.json()
    return Array.isArray(j.notes) ? j.notes : []
  } catch {
    return []
  }
}

async function list() {
  return (await api('GET', '/admin/objects')).objects
}

async function upload(key, file) {
  const size = (await stat(file)).size
  const existing = (await list()).find((o) => o.key === key)
  if (existing && existing.size === size) {
    console.log(`  ${key}: already in the bucket at ${size} bytes`)
    return
  }
  const { uploadId } = await api('POST', '/admin/upload/start', { key })
  const fh = await open(file, 'r')
  const parts = []
  try {
    const total = Math.ceil(size / PART_SIZE)
    for (let n = 1; n <= total; n++) {
      const offset = (n - 1) * PART_SIZE
      const len = Math.min(PART_SIZE, size - offset)
      const buf = new Uint8Array(len)
      const { bytesRead } = await fh.read(buf, 0, len, offset)
      if (bytesRead !== len) throw new Error(`short read at part ${n}`)
      let last
      for (let attempt = 1; attempt <= 4; attempt++) {
        try {
          const r = await api('PUT', `/admin/upload/part?key=${encodeURIComponent(key)}&uploadId=${encodeURIComponent(uploadId)}&part=${n}`, buf, { 'Content-Type': 'application/octet-stream', 'Content-Length': String(len) })
          parts.push({ partNumber: r.partNumber, etag: r.etag })
          last = null
          break
        } catch (e) {
          last = e
          console.log(`  part ${n}/${total} attempt ${attempt} failed: ${e.message}`)
          await new Promise((r) => setTimeout(r, 2000 * attempt))
        }
      }
      if (last) throw last
      process.stdout.write(`  ${key}: part ${n}/${total} (${Math.round(((offset + len) / size) * 100)}%)\r`)
    }
    const done = await api('POST', '/admin/upload/complete', { key, uploadId, parts })
    console.log(`\n  ${key}: uploaded, ${done.size} bytes`)
    if (done.size !== size) throw new Error(`bucket has ${done.size} bytes, file is ${size}`)
  } catch (e) {
    await api('POST', '/admin/upload/abort', { key, uploadId }).catch(() => {})
    throw e
  } finally {
    await fh.close()
  }
}

async function release() {
  const version = arg('version')
  if (!/^\d+\.\d+\.\d+$/.test(version || '')) throw new Error('--version X.Y.Z is required')
  const win = arg('win')
  const mac = arg('mac')
  const macZip = arg('mac-zip')
  if (!win && !mac) throw new Error('--win and/or --mac installer paths are required')
  if (macZip && !mac) throw new Error('--mac-zip goes with --mac')
  if (mac && !macZip) console.log('note: no --mac-zip, so this release has no automatic update for Mac')
  const files = {}
  for (const [os, file, name, withSha512] of [
    ['win', win, `Reel-Studio-Setup-${version}-x64.exe`, true],
    ['mac', mac, `Reel-Studio-${version}-arm64.dmg`, false],
    ['macZip', macZip, `Reel-Studio-${version}-arm64-mac.zip`, true]
  ]) {
    if (!file) continue
    const size = (await stat(file)).size
    console.log(`${os}: ${basename(file)} (${size} bytes), hashing…`)
    const h = await hashes(file)
    files[os] = { name, key: `v${version}/${name}`, size, sha256: h.sha256, ...(withSha512 ? { sha512: h.sha512 } : {}), _file: file }
    console.log(`  sha256 ${h.sha256}${withSha512 ? `\n  sha512 ${h.sha512}` : ''}`)
  }
  const published = new Date().toISOString().slice(0, 10)
  const manifest = { version, page: arg('page', 'https://getreelstudio.com/update.html'), published, files: {} }
  for (const [os, f] of Object.entries(files)) {
    const { _file, ...entry } = f
    manifest.files[os] = entry
  }
  const notesFile = arg('notes')
  const earlier = (await currentNotes()).filter((n) => n && n.version !== version)
  const mine = notesFile ? [{ version, date: published, text: (await readFile(notesFile, 'utf8')).trim() }] : []
  if (mine.length && mine[0].text.length > 4000) throw new Error('--notes: keep it under 4000 characters')
  manifest.notes = [...mine, ...earlier].slice(0, 5)
  console.log('manifest:', JSON.stringify(manifest, null, 2))
  if (has('dry-run')) return console.log('dry run: nothing uploaded, nothing published')
  for (const f of Object.values(files)) await upload(f.key, f._file)
  const r = await api('PUT', '/admin/manifest', manifest)
  console.log('published:', JSON.stringify(r.published))
}

async function main() {
  if (!SECRET) throw new Error('DOWNLOADS_ADMIN_SECRET is not set')
  const cmd = process.argv[2]
  if (cmd === 'list') {
    const objects = await list()
    for (const o of objects) console.log(`${o.size.toString().padStart(12)}  ${o.uploaded}  ${o.key}`)
    if (!objects.length) console.log('(empty)')
  } else if (cmd === 'upload') {
    const key = arg('key')
    const file = arg('file')
    if (!key || !file) throw new Error('--key and --file are required')
    await upload(key, file)
  } else if (cmd === 'delete') {
    const key = arg('key')
    if (!key) throw new Error('--key is required')
    console.log(await api('DELETE', `/admin/objects?key=${encodeURIComponent(key)}`))
  } else if (cmd === 'release') {
    await release()
  } else if (cmd === 'link') {
    // Support: a buyer lost their link. Find the Checkout Session id in the Stripe dashboard (Payments → the
    // payment → Checkout session) and mint fresh links to send them.
    const sid = arg('sid')
    if (!sid) throw new Error('--sid cs_live_… is required')
    const r = await api('POST', '/admin/link', { sid, plan: arg('plan', 'once') })
    console.log(`${r.onFile ? 'on file' : 'NOT on file (links still work)'}, plan ${r.plan}, version ${r.version}\nMac:     ${r.mac}\nWindows: ${r.win}`)
  } else if (cmd === 'forget') {
    // The buyer asked us to delete their record: everything about this purchase goes now, and its links and
    // automatic updates stop working. Stripe's own records are separate.
    const sid = arg('sid')
    if (!sid) throw new Error('--sid cs_live_… is required')
    console.log(await api('DELETE', `/admin/purchase?sid=${encodeURIComponent(sid)}`))
  } else if (cmd === 'purchase') {
    // Support: does this purchase still get downloads and updates, and why not?
    const sid = arg('sid')
    if (!sid) throw new Error('--sid cs_live_… is required')
    console.log(JSON.stringify(await api('GET', `/admin/purchase?sid=${encodeURIComponent(sid)}`), null, 2))
  } else {
    console.log('usage: publish.mjs list | upload --key K --file F | delete --key K | release --version V --win F --mac F [--mac-zip F] [--notes F] [--dry-run] | link --sid cs_live_… | purchase --sid cs_live_… | forget --sid cs_live_…')
    process.exitCode = 2
  }
}

main().catch((e) => {
  console.error(`publish: ${e.message}`)
  process.exitCode = 1
})
