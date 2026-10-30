// The release manifest: which version is current and which files in R2 belong to it. Written by the
// release script into KV key `manifest`; read by /latest.json, the thanks page and every download.
export interface ManifestFile {
  /** The file name the person sees, e.g. Reel-Studio-Setup-0.1.3-x64.exe */
  name: string
  /** The R2 object key, e.g. v0.1.3/Reel-Studio-Setup-0.1.3-x64.exe */
  key: string
  size: number
  sha256: string
}

export interface Manifest {
  version: string
  /** The page the app's update card opens. */
  page?: string
  published?: string
  files: { win?: ManifestFile; mac?: ManifestFile }
}

export const MANIFEST_KEY = 'manifest'
const VERSION_RE = /^\d+\.\d+\.\d+$/

function validFile(f: unknown): f is ManifestFile {
  if (!f || typeof f !== 'object') return false
  const { name, key, size, sha256 } = f as Record<string, unknown>
  return (
    typeof name === 'string' &&
    /^[A-Za-z0-9._-]+$/.test(name) &&
    typeof key === 'string' &&
    key.length > 0 &&
    typeof size === 'number' &&
    size > 0 &&
    typeof sha256 === 'string'
  )
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
  if (!out.files.win && !out.files.mac) return null
  if (typeof m.page === 'string') out.page = m.page
  if (typeof m.published === 'string') out.published = m.published
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

export function fileByName(m: Manifest, name: string): ManifestFile | null {
  for (const f of [m.files.win, m.files.mac]) if (f && f.name === name) return f
  return null
}

/** What the app's update check reads: version, page to open, file names and hashes. No keys, no links. */
export function publicLatest(m: Manifest, defaultPage: string) {
  const pub = (f?: ManifestFile) => (f ? { name: f.name, size: f.size, sha256: f.sha256 } : undefined)
  return { version: m.version, url: m.page ?? defaultPage, files: { win: pub(m.files.win), mac: pub(m.files.mac) } }
}
