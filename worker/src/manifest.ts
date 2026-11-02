// The release manifest: which version is current and which files in R2 belong to it. Written by the
// release script into KV key `manifest`; read by /latest.json, the thanks page, every download and the
// update feed (/u/), which renders electron-updater's latest.yml / latest-mac.yml from it, so the feed can
// never name a different version or file than the manifest.
export interface ManifestFile {
  /** The file name the person sees, e.g. Reel-Studio-Setup-0.1.3-x64.exe */
  name: string
  /** The R2 object key, e.g. v0.1.3/Reel-Studio-Setup-0.1.3-x64.exe */
  key: string
  size: number
  sha256: string
  /** base64 SHA-512, what electron-updater checks. Required for a file the update feed serves. */
  sha512?: string
}

export interface ReleaseNote {
  version: string
  /** YYYY-MM-DD */
  date: string
  /** Plain text (a few short lines, markdown-ish bullets). */
  text: string
}

export interface Manifest {
  version: string
  /** The page the app's update card opens. */
  page?: string
  published?: string
  /** win: the NSIS installer (also what the Windows updater runs). mac: the dmg people download.
   * macZip: the signed, stapled .app zipped, which is what the Mac updater (Squirrel.Mac) installs. */
  files: { win?: ManifestFile; mac?: ManifestFile; macZip?: ManifestFile }
  /** The newest releases first, at most MAX_NOTES. */
  notes?: ReleaseNote[]
}

export type UpdateOs = 'win' | 'mac'

export const MANIFEST_KEY = 'manifest'
export const MAX_NOTES = 5
const MAX_NOTE_LENGTH = 4000
const VERSION_RE = /^\d+\.\d+\.\d+$/
const SHA512_B64_RE = /^[A-Za-z0-9+/]{86}==$/

function validFile(f: unknown): f is ManifestFile {
  if (!f || typeof f !== 'object') return false
  const { name, key, size, sha256, sha512 } = f as Record<string, unknown>
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(name) &&
    typeof key === 'string' &&
    key.length > 0 &&
    typeof size === 'number' &&
    size > 0 &&
    typeof sha256 === 'string' &&
    (sha512 === undefined || (typeof sha512 === 'string' && SHA512_B64_RE.test(sha512)))
  )
}

function validNote(n: unknown): n is ReleaseNote {
  if (!n || typeof n !== 'object') return false
  const { version, date, text } = n as Record<string, unknown>
  return typeof version === 'string' && VERSION_RE.test(version) && typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date) && typeof text === 'string' && text.length <= MAX_NOTE_LENGTH
}

/** The manifest, or null if absent or malformed (then nothing is downloadable, which is the safe side). */
export function parseManifest(v: unknown): Manifest | null {
  if (!v || typeof v !== 'object') return null
  const m = v as Record<string, unknown>
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version)) return null
  const files = m.files && typeof m.files === 'object' ? (m.files as Record<string, unknown>) : {}
  const out: Manifest = { version: m.version, files: {} }
  if (validFile(files.win)) out.files.win = files.win
  if (validFile(files.mac)) out.files.mac = files.mac
  if (validFile(files.macZip)) out.files.macZip = files.macZip
  if (!out.files.win && !out.files.mac) return null
  if (typeof m.page === 'string') out.page = m.page
  if (typeof m.published === 'string') out.published = m.published
  if (Array.isArray(m.notes)) {
    const notes = m.notes.filter(validNote).slice(0, MAX_NOTES)
    if (notes.length) out.notes = notes.map(({ version, date, text }) => ({ version, date, text }))
  }
  return out
}

export async function loadManifest(kv: { get(key: string, type: 'text'): Promise<string | null> }): Promise<Manifest | null> {
  const raw = await kv.get(MANIFEST_KEY, 'text')
  if (!raw) return null
  try {
    return parseManifest(JSON.parse(raw))
  } catch {
    return null
  }
}

/** A file people download from /d/: the installers, not the updater's zip. */
export function fileByName(m: Manifest, name: string): ManifestFile | null {
  for (const f of [m.files.win, m.files.mac]) if (f && f.name === name) return f
  return null
}

/** The file the updater installs on this OS, if the release has one with a SHA-512. */
export function updateFile(m: Manifest, os: UpdateOs): ManifestFile | null {
  const f = os === 'win' ? m.files.win : m.files.macZip
  return f && f.sha512 ? f : null
}

/** A file the update feed (/u/) serves, by exact name. */
export function updateFileByName(m: Manifest, name: string): ManifestFile | null {
  for (const os of ['win', 'mac'] as const) {
    const f = updateFile(m, os)
    if (f && f.name === name) return f
  }
  return null
}

/** electron-updater's latest.yml / latest-mac.yml for the current release (generic provider: file URLs are
 * relative to the feed, /u/). Every value is either from the validated manifest or a number, so nothing
 * needs YAML quoting except the date, which is quoted. */
export function updateYml(m: Manifest, os: UpdateOs): string | null {
  const f = updateFile(m, os)
  if (!f) return null
  const date = m.published && /^\d{4}-\d{2}-\d{2}$/.test(m.published) ? `${m.published}T00:00:00.000Z` : '1970-01-01T00:00:00.000Z'
  return [
    `version: ${m.version}`,
    'files:',
    `  - url: ${f.name}`,
    `    sha512: ${f.sha512}`,
    `    size: ${f.size}`,
    `path: ${f.name}`,
    `sha512: ${f.sha512}`,
    `releaseDate: '${date}'`,
    ''
  ].join('\n')
}

/** What the app's update check reads: version, page to open, file names and hashes, release notes. No keys,
 * no links. */
export function publicLatest(m: Manifest, defaultPage: string) {
  const pub = (f?: ManifestFile) => (f ? { name: f.name, size: f.size, sha256: f.sha256 } : undefined)
  return { version: m.version, url: m.page ?? defaultPage, files: { win: pub(m.files.win), mac: pub(m.files.mac) }, notes: m.notes ?? [] }
}
