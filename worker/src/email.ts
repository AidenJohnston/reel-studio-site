// "Email me my link": the plain message a buyer gets. Both text and HTML, nothing tracked.
export interface LinkEmailInput {
  /** receipt = right after the purchase; resend = the buyer asked for the link again. */
  reason: 'receipt' | 'resend'
  plan: 'once' | 'monthly'
  version: string
  win?: { name: string; url: string }
  mac?: { name: string; url: string }
  /** The page that turns on automatic updates in the app (hands it the key). */
  updatesUrl?: string
  siteOrigin: string
  supportEmail: string
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function linkEmail(i: LinkEmailInput): { subject: string; text: string; html: string } {
  const receipt = i.reason === 'receipt'
  const subject = receipt ? 'Your Reel Studio download' : `Your Reel Studio ${i.version} download link`
  const opening = receipt
    ? i.plan === 'monthly'
      ? `Thanks for subscribing to Reel Studio. Your subscription includes every update while it is active. Here is your download link for version ${i.version}. Your payment receipt comes separately from Stripe.`
      : `Thanks for buying Reel Studio. Your purchase includes all future updates. Here is your download link for version ${i.version}. Your payment receipt comes separately from Stripe.`
    : `Here is your download link for Reel Studio ${i.version}.`
  const lines = [opening, '']
  if (i.mac) lines.push('Mac (Apple silicon, macOS 14 or newer):', i.mac.url, '')
  if (i.win) lines.push('Windows 10/11 (64-bit):', i.win.url, '')
  if (i.updatesUrl) lines.push('Once Reel Studio is installed, open this link to turn on automatic updates:', i.updatesUrl, '')
  lines.push(
    'The link is yours: it keeps working for new versions too, so keep this email.',
    'On a Mac, drag Reel Studio into Applications and open it. On Windows, if a blue "Windows protected your PC" box appears, click More info, then Run anyway.',
    '',
    `If you did not ask for this email, you can ignore it. Questions: ${i.supportEmail}`,
    '',
    `Reel Studio, ${i.siteOrigin}`
  )
  const text = lines.join('\n')
  const button = (label: string, f: { name: string; url: string }) =>
    `<p style="margin:0 0 16px"><a href="${esc(f.url)}" style="display:inline-block;padding:12px 20px;background:#111;color:#fff;border-radius:8px;text-decoration:none;font-weight:600">${esc(label)}</a><br><span style="color:#666;font-size:13px">${esc(f.name)}</span></p>`
  const html = `<!doctype html><html><body style="font-family:-apple-system,Segoe UI,Helvetica,Arial,sans-serif;color:#111;line-height:1.5;max-width:560px;margin:0 auto;padding:24px">
<h1 style="font-size:20px;margin:0 0 16px">${receipt ? 'Your Reel Studio download' : `Your Reel Studio ${esc(i.version)} download`}</h1>
<p>${esc(opening)}</p>
${i.mac ? button('Download for Mac', i.mac) : ''}${i.win ? button('Download for Windows', i.win) : ''}
${i.updatesUrl ? `<p style="margin:0 0 16px">Once Reel Studio is installed: <a href="${esc(i.updatesUrl)}">turn on automatic updates</a>.</p>` : ''}
<p>The link is yours: it keeps working for new versions too, so keep this email.</p>
<p style="color:#444">On a Mac, drag Reel Studio into Applications and open it. On Windows, if a blue "Windows protected your PC" box appears, click <b>More info</b>, then <b>Run anyway</b>.</p>
<p style="color:#666;font-size:13px">If you did not ask for this email, you can ignore it. Questions: <a href="mailto:${esc(i.supportEmail)}">${esc(i.supportEmail)}</a><br>Reel Studio, <a href="${esc(i.siteOrigin)}">${esc(i.siteOrigin)}</a></p>
</body></html>`
  return { subject, text, html }
}

/** The short notice support gets for each report from the app. Plain text: it quotes what the reporter typed,
 * and the screenshot and diagnostics stay on the dashboard (behind the admin secret), never in a mailbox. */
export function supportNotice(
  r: { id: string; created: number; what: string; expected: string; email: string | null; appVersion: string; os: string; screenshot: unknown; diagnostics: string; key: { status: string; plan?: string; entitled?: boolean } },
  dashboardUrl: string
): { subject: string; text: string } {
  const flat = (s: string) => s.replace(/\s+/g, ' ').trim()
  const head = (s: string, lines: number, chars: number) => {
    const kept = s.split('\n').slice(0, lines).join('\n')
    const cut = kept.length > chars ? kept.slice(0, chars - 1) + '…' : kept
    return cut + (cut.length < s.length ? '\n[…]' : '')
  }
  const first = flat(r.what.split('\n').find((l) => l.trim()) ?? '')
  const subject = `Report ${r.id}: ${first.length > 70 ? first.slice(0, 69) + '…' : first}`
  const who =
    r.key.status === 'valid' ? `key: ${r.key.plan ?? '?'} purchase${r.key.entitled === false ? ' (no longer entitled)' : ''}` : r.key.status === 'invalid' ? 'key: sent, not ours' : 'key: none'
  const lines = [
    `Report ${r.id}, ${new Date(r.created).toISOString().replace('T', ' ').slice(0, 16)} UTC`,
    `Reel Studio ${r.appVersion} on ${flat(r.os)}; ${who}`,
    `Reply to: ${r.email ?? 'no email given'}`,
    '',
    'What happened:',
    head(r.what, 8, 800),
    ''
  ]
  if (r.expected) lines.push('Expected:', head(r.expected, 4, 400), '')
  lines.push(`Screenshot: ${r.screenshot ? 'yes' : 'no'}. Diagnostics: ${r.diagnostics ? 'yes' : 'no'}.`, `Open it: ${dashboardUrl}`)
  return { subject, text: lines.join('\n') }
}
