// Streams one R2 object as a download: HEAD, Range (a download manager resuming), If-Range and If-None-Match.
// Shared by the paid installer route (/d/…) and the public source route (/source/…).
//
// The Range is parsed and checked against the object's size here, never handed to R2 as is: R2 throws on a
// range it cannot satisfy. Only If-None-Match reaches R2's conditional get; If-Match and If-Unmodified-Since
// are ignored (a download never sends them, and passing them to R2 would turn a failed one into a 304).

/** A byte range checked against the size: the bytes to send, `unsatisfiable` (416), or null for "send it
 * all" (no Range, one we do not parse, such as several ranges, or one that covers the whole object). */
export function parseRange(h: string | null, size: number): { offset: number; length: number } | 'unsatisfiable' | null {
  if (!h) return null
  const m = /^bytes=(\d*)-(\d*)$/.exec(h.trim())
  if (!m || (m[1] === '' && m[2] === '')) return null
  let start: number
  let end: number
  if (m[1] === '') {
    const suffix = Number(m[2])
    if (suffix === 0 || size === 0) return 'unsatisfiable'
    start = Math.max(0, size - suffix)
    end = size - 1
  } else {
    start = Number(m[1])
    end = m[2] === '' ? size - 1 : Math.min(size - 1, Number(m[2]))
    if (m[2] !== '' && Number(m[2]) < start) return null // "bytes=5-2" is invalid: ignore it
    if (start >= size) return 'unsatisfiable'
  }
  if (start === 0 && end === size - 1) return null
  return { offset: start, length: end - start + 1 }
}

/** The object's response, with `headers` (the caller's Content-Type, Disposition, Cache-Control) plus
 * ETag, Content-Length and Content-Range. null when the key is not in the bucket. */
export async function streamObject(request: Request, bucket: R2Bucket, key: string, headers: Headers): Promise<Response | null> {
  const ifNoneMatch = request.headers.get('If-None-Match')
  const onlyIf = ifNoneMatch ? new Headers({ 'If-None-Match': ifNoneMatch }) : undefined
  const rangeHeader = request.headers.get('Range')
  if (request.method === 'HEAD' || rangeHeader) {
    // A Range needs the size before R2 is asked for the bytes.
    const head = await bucket.head(key)
    if (!head) return null
    headers.set('ETag', head.httpEtag)
    if (request.method === 'HEAD') {
      headers.set('Content-Length', String(head.size))
      return new Response(null, { status: 200, headers })
    }
    // If-Range: the range only for the same file; anything else (another ETag, a date) gets it all.
    const ifRange = request.headers.get('If-Range')
    const range = ifRange && ifRange !== head.httpEtag ? null : parseRange(rangeHeader, head.size)
    if (range === 'unsatisfiable') {
      headers.delete('Content-Disposition')
      headers.set('Cache-Control', 'no-store')
      headers.set('Content-Range', `bytes */${head.size}`)
      return new Response(null, { status: 416, headers })
    }
    if (range) {
      const obj = await bucket.get(key, { range, onlyIf })
      if (!obj) return null
      if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers })
      headers.set('Content-Range', `bytes ${range.offset}-${range.offset + range.length - 1}/${head.size}`)
      headers.set('Content-Length', String(range.length))
      return new Response(obj.body, { status: 206, headers })
    }
  }
  const obj = await bucket.get(key, { onlyIf })
  if (!obj) return null
  headers.set('ETag', obj.httpEtag)
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers })
  headers.set('Content-Length', String(obj.size))
  return new Response(obj.body, { status: 200, headers })
}
