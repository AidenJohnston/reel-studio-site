// The only browser pages this Worker serves: the outcomes of connecting YouTube (/oauth/youtube/begin and the
// OAuth callback). One inline-styled page each, in the look of the downloads Worker's pages. The person reads
// one and goes back to Reel Studio, which learns the outcome by polling the attempt.

export type PageKind = 'connected' | 'denied' | 'missing_permission' | 'no_channel' | 'expired' | 'not_entitled' | 'failed'

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!)
}

function copy(kind: PageKind, opts: { channelName?: string | null; siteOrigin: string }): { status: number; title: string; body: string } {
  switch (kind) {
    case 'connected': {
      const channel = opts.channelName ? escapeHtml(opts.channelName) : 'your channel'
      return {
        status: 200,
        title: 'YouTube is connected',
        body: `Reel Studio can now post to ${channel}, only when you click Post. Go back to Reel Studio to finish. You can close this tab.`
      }
    }
    case 'denied':
      return {
        status: 200,
        title: 'Nothing was connected',
        body: "You didn't allow Reel Studio to post to YouTube, so nothing changed. To try again, go back to Reel Studio and click Connect YouTube."
      }
    case 'missing_permission':
      return {
        status: 200,
        title: 'Reel Studio needs permission to upload',
        body: 'Google didn\'t give Reel Studio permission to upload videos. Go back to Reel Studio, click Connect YouTube, and leave "Manage your YouTube videos" ticked.'
      }
    case 'no_channel':
      return {
        status: 200,
        title: 'This Google account has no YouTube channel',
        body: 'Create a channel at youtube.com first, then go back to Reel Studio and click Connect YouTube.'
      }
    case 'expired':
      return { status: 410, title: 'This link has expired', body: 'Go back to Reel Studio and click Connect YouTube again.' }
    case 'not_entitled':
      return {
        status: 403,
        title: 'Posting needs an active subscription',
        body: `The purchase behind this computer's sign-in has ended. <a href="${escapeHtml(opts.siteOrigin)}/#pricing">Subscribe again</a> to post from Reel Studio.`
      }
    case 'failed':
      return {
        status: 502,
        title: "YouTube couldn't be connected",
        body: 'Something went wrong between our server and Google. Go back to Reel Studio and try again in a minute.'
      }
  }
}

export function page(kind: PageKind, opts: { channelName?: string | null; siteOrigin: string; headers?: Record<string, string> }): Response {
  const c = copy(kind, opts)
  const html = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${c.title}</title><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;max-width:560px;margin:48px auto;padding:0 24px;line-height:1.5"><h1>${c.title}</h1><p>${c.body}</p></body>`
  return new Response(html, { status: c.status, headers: { ...pageHeaders(), ...opts.headers } })
}

export function pageHeaders(): Record<string, string> {
  return {
    'Content-Type': 'text/html; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Referrer-Policy': 'no-referrer',
    'X-Content-Type-Options': 'nosniff'
  }
}
