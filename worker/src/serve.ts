// Streams one R2 object as a download: HEAD, Range (a download manager resuming) and If-None-Match.
// Shared by the paid installer route (/d/…) and the public source route (/source/…).

/** The object's response, with `headers` (the caller's Content-Type, Disposition, Cache-Control) plus
 * ETag, Content-Length and Content-Range. null when the key is not in the bucket. */
export async function streamObject(request: Request, bucket: R2Bucket, key: string, headers: Headers): Promise<Response | null> {
  if (request.method === 'HEAD') {
    const head = await bucket.head(key)
    if (!head) return null
    headers.set('Content-Length', String(head.size))
    headers.set('ETag', head.httpEtag)
    return new Response(null, { status: 200, headers })
  }
  const obj = await bucket.get(key, { range: request.headers, onlyIf: request.headers })
  if (!obj) return null
  headers.set('ETag', obj.httpEtag)
  if (!('body' in obj) || !obj.body) return new Response(null, { status: 304, headers })
  const range = obj.range
  let status = 200
  if (range) {
    const total = obj.size
    const start = 'offset' in range && typeof range.offset === 'number' ? range.offset : 'suffix' in range && typeof range.suffix === 'number' ? Math.max(0, total - range.suffix) : 0
    const len = 'length' in range && typeof range.length === 'number' ? range.length : total - start
    const end = Math.min(total - 1, start + len - 1)
    if (start > 0 || end < total - 1) {
      status = 206
      headers.set('Content-Range', `bytes ${start}-${end}/${total}`)
      headers.set('Content-Length', String(end - start + 1))
    } else headers.set('Content-Length', String(total))
  } else headers.set('Content-Length', String(obj.size))
  return new Response(obj.body, { status, headers })
}
