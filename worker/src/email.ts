// "Email me my link": the plain message a buyer gets. Both text and HTML, nothing tracked.
export interface LinkEmailInput {
  /** receipt = right after the purchase; resend = the buyer asked for the link again. */
  reason: 'receipt' | 'resend'
  plan: 'once' | 'monthly'
  version: string
  win?: { name: string; url: string }
  mac?: { name: string; url: string }
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
      ? `Thanks for subscribing to Reel Studio. Here is your download link for version ${i.version}. Your payment receipt comes separately from Stripe.`
      : `Thanks for buying Reel Studio. Your license covers this version and every 1.x update. Here is your download link for version ${i.version}. Your payment receipt comes separately from Stripe.`
    : `Here is your download link for Reel Studio ${i.version}.`
  const lines = [opening, '']
  if (i.mac) lines.push('Mac (Apple silicon, macOS 14 or newer):', i.mac.url, '')
  if (i.win) lines.push('Windows 10/11 (64-bit):', i.win.url, '')
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
<p>The link is yours: it keeps working for new versions too, so keep this email.</p>
<p style="color:#444">On a Mac, drag Reel Studio into Applications and open it. On Windows, if a blue "Windows protected your PC" box appears, click <b>More info</b>, then <b>Run anyway</b>.</p>
<p style="color:#666;font-size:13px">If you did not ask for this email, you can ignore it. Questions: <a href="mailto:${esc(i.supportEmail)}">${esc(i.supportEmail)}</a><br>Reel Studio, <a href="${esc(i.siteOrigin)}">${esc(i.siteOrigin)}</a></p>
</body></html>`
  return { subject, text, html }
}
