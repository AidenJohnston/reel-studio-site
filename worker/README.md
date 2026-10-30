# Reel Studio download server

The Cloudflare Worker behind `https://dl.getreelstudio.com`. It hands paying customers their installer and
tells the app whether a newer version is out. No account, no cookie, no analytics.

## How a purchase becomes a download

1. The buyer pays through a Stripe Payment Link, which sends them to
   `https://getreelstudio.com/thanks.html?plan=…&session_id={CHECKOUT_SESSION_ID}`.
2. `thanks.html` (with `downloads.js`) calls `GET /api/claim?session_id=…`. The Worker checks its KV record of
   that Checkout Session, or asks Stripe for it with a restricted read-only key, and requires
   `status=complete` and `payment_status=paid`. It records the purchase (session id, plan, timestamps and a keyed
   hash of the email, never the address) and answers a signed token plus one download link per platform.
3. The link is `GET /d/<token>/<file name>`. The token is HMAC-signed (`src/token.ts`), lasts 400 days, and the
   file name must be one of the current release's. The file streams from the private R2 bucket
   `reel-studio-installers` with resume support.
4. The thanks page remembers the token in the buyer's browser. `update.html` (what the app's update card opens)
   uses it to offer the newest version, and otherwise shows the "email me my link" form, which posts to
   `POST /api/link`. That answers `{delivery: "email"}` and sends a fresh link if Email Sending is configured,
   or `{delivery: "support"}` so the page tells the buyer to email support instead.
5. `POST /stripe/webhook` records `checkout.session.completed` events (signature verified) so the email form
   works even for buyers who never opened the thanks page.
6. `GET /latest.json` is the tokenless manifest the app's update check reads: version, the page to open, and the
   file names, sizes and SHA-256 hashes. Cached five minutes.

## Releasing a version

The manifest lives in KV (`manifest`); the installers in R2 under `v<version>/`. Both are written by
`tools/publish.mjs` through the authenticated `/admin/*` routes (multipart upload, because one request to a
Worker carries at most 100 MB and wrangler refuses files over 300 MiB):

```
set DOWNLOADS_ADMIN_SECRET=…
node tools/publish.mjs release --version 0.1.3 --win "…\Reel Studio Setup 0.1.3.exe" --mac "…\Reel Studio 0.1.3.dmg" --dry-run
node tools/publish.mjs release --version 0.1.3 --win "…" --mac "…"
node tools/publish.mjs list
```

`release` hashes the files, uploads what is missing, and publishes the manifest; the Worker refuses a manifest
whose files are not in the bucket at the stated size. The app sees the new version within five minutes.
Old versions can be removed with `delete --key v0.1.2/…`.

Support: a buyer lost their link. Find the Checkout Session id in Stripe (Payments → the payment → Checkout
session, `cs_live_…`) and run `node tools/publish.mjs link --sid cs_live_…` to mint fresh links to send them.

## Setup

```
npm install
npm test                 # vitest, in-memory bindings
npm run typecheck
npx wrangler deploy      # needs wrangler login on the account that owns getreelstudio.com
```

Secrets (`npx wrangler secret put NAME`):

| Secret | What |
|---|---|
| `TOKEN_SECRET` | 32+ random bytes. Signs download tokens and keys the email hashes. Rotating it invalidates every link. |
| `STRIPE_SECRET_KEY` | A **restricted** Stripe key with only *Checkout Sessions: Read*. |
| `STRIPE_WEBHOOK_SECRET` | The signing secret of the Stripe webhook endpoint `https://dl.getreelstudio.com/stripe/webhook` (event `checkout.session.completed`). |
| `ADMIN_SECRET` | 32+ random bytes for `tools/publish.mjs`. Without it the `/admin` routes do not exist. |

Bindings (`wrangler.jsonc`): KV `PURCHASES`, R2 `INSTALLERS`, and optionally the `send_email` binding `EMAIL`
once Email Sending is enabled for the domain (Workers Paid plan). Until then "email me my link" degrades to
"email support".

## Privacy

The Worker stores, per purchase: the Stripe Checkout Session id, the plan, Stripe's customer id, the time, and
`HMAC(TOKEN_SECRET, email)`. Logs carry a shortened session id and a file name. The download token holds the
session id, the plan and an expiry.
