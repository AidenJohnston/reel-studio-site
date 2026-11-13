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
   `POST /api/link`. That answers `{delivery: "email"}` and sends a fresh link (Cloudflare Email Sending from
   support@getreelstudio.com), or `{delivery: "support"}` if the binding is absent, so the page tells the buyer
   to email support instead.
5. `POST /stripe/webhook` records `checkout.session.completed` events (signature verified) and emails the buyer
   their download links at once (the receipt; Stripe's own payment receipt is separate), plus a link to
   `updates.html#key=<token>`, which hands the key to the app (`reelstudio://updates?key=…`) so it can update
   itself. A buyer who closes the thanks page, or never reaches it, still gets what they paid for. A retried
   event does not send twice. The same endpoint keeps what a purchase is entitled to current (see below).
6. `GET /latest.json` is the tokenless manifest the app's update check reads: version, the page to open, and the
   file names, sizes and SHA-256 hashes. Cached five minutes.

7. `GET /u/latest.yml`, `GET /u/latest-mac.yml`, `GET /u/<file>`: the update feed for the app's updater
   (electron-updater, generic provider at `https://dl.getreelstudio.com/u/`). The yml is rendered from the
   manifest (Windows: the NSIS installer; Mac: the zipped, stapled .app, which is what Squirrel.Mac installs),
   so it can never name another version or file. Every request needs `Authorization: Bearer <download token>`;
   the token's age is ignored and the purchase is checked instead: 401 no key / not ours, 403
   `{"error":"not entitled","reason":…}` when the purchase no longer is.

8. `GET /source/<release>/<file>` is public, no token: the corresponding source of the open-source programs
   in the installers (FFmpeg and its libraries), from R2 keys under `source/` only. `/source/` and
   `/source/<release>/` list them (from the Workers cache for five minutes, so a new folder takes up to five
   minutes to appear); https://getreelstudio.com/source.html says what each file is.

## Who is entitled

`src/records.ts` `entitlement()`, used by the update feed, `/d/`, the claim and "email me my link":

- **Monthly:** while the subscription is `active`, `trialing`, `past_due` (Stripe still retrying the card) or
  `incomplete` (only seen for a moment during Checkout). `canceled`, `unpaid`, `incomplete_expired` and `paused`
  end it. Cancelling in the billing portal ends it at the end of the paid month, when Stripe says `canceled`.
- **One-time ($99, no longer sold):** always, unless the payment was refunded in full or is disputed (a dispute
  won, or an inquiry closed without a chargeback, restores it).

The webhook stores what Stripe says under its own keys, `sub:<subscription id>` and `pay:<payment intent id>`,
whether or not the purchase is on file yet, and an older event never overwrites a newer one, so the order Stripe
sends events in does not matter. Refunds and disputes of a monthly invoice are not tracked: the subscription's
status decides. Support can see one purchase with `node tools/publish.mjs purchase --sid cs_live_…`.

**Retention.** A record is kept while its purchase is entitled. When it stops being entitled, every KV key of
that purchase (`sess:`, the `email:` pointer if it still points there, `sub:`/`subsess:`, `pay:`/`paysess:`) gets a
90-day expiry; if it becomes entitled again the expiry is lifted. A buyer who asks to be deleted sooner:
`node tools/publish.mjs forget --sid cs_live_…` (their links and updates stop). One-time purchases stay entitled,
so their records stay until the buyer asks.

## Support reports

The app's "Report a problem" form posts to `POST /v1/support` (`src/support.ts`); the reports land on an internal
dashboard at `https://dl.getreelstudio.com/admin/support` (`src/support-admin.ts`). Billing still goes to
support@getreelstudio.com.

- **What a report holds.** What happened (required, 5,000 characters), what they expected (3,000), an optional email
  (stored as typed, so someone can answer), optional diagnostics text (the app's redacted "Copy diagnostics", 200,000
  characters), the app version, the OS, and an optional PNG or JPEG screenshot of the app window (2 MB; the type is
  checked from the bytes). The request is `multipart/form-data` and is refused past 3 MB without being read further.
  Every field is trimmed and stripped of control characters; the report gets an id like `RS-7K3F9QXA` and status `new`.
- **The key.** The app sends its download key as `Authorization: Bearer <key>` when it has one. A key we signed tells
  the dashboard which purchase it is (the Checkout Session id, the plan, whether it is still entitled); the key itself
  is not stored. A report with no key, or a key that is not ours, is still taken.
- **Limits.** 10 reports an hour per IP and 10 per purchase key (KV counters, a brake rather than a wall). At most 100
  notice emails a day; reports past that are stored and show on the dashboard.
- **Storage.** The same `PURCHASES` KV, no new binding: `support:r:<ref>` (the report, with list metadata so the
  dashboard lists without reading each one) and `support:shot:<ref>` (the screenshot bytes). Both expire 180 days
  after the report came in; a status change keeps the expiry; the dashboard can delete one sooner. No public route
  reads either key.
- **Notice email.** Each report sends support@getreelstudio.com a short plain-text notice (from itself, Reply-To the
  reporter's email when they gave one): the id, version, OS, whether a key came, the first 8 lines of what happened
  and the first 4 of what they expected, and a link to the report on the dashboard. The screenshot and the diagnostics
  stay on the dashboard, never in the mailbox. Without the `EMAIL` binding (staging) nothing is sent.
- **The dashboard.** Open `/admin/support` in a browser and paste the admin secret (`ADMIN_SECRET`, or
  `SUPPORT_ADMIN_SECRET`, which opens only this). The page holds no data itself: its script keeps the secret in that
  tab's sessionStorage and calls `/admin/support/api/…` with `Authorization: Bearer`, like every admin route, so no
  cookie exists for another site to ride on. It lists reports newest first (filter by status), shows one with its
  screenshot and diagnostics, sets status (new, triaged, fixed in a version, won't fix) with an internal note, and
  deletes. Everything the reporter typed goes on the page as text, never HTML, under a strict CSP. Without either
  secret configured, `/admin/support` is a 404.

Try it on staging (`--env staging` deploys the same code there; it has no email binding, so no notices):

```
npx wrangler deploy --env staging
curl -F "what=Test report from staging" -F appVersion=0.1.6 -F "os=Windows 10.0.26200 x64" https://dl-staging.getreelstudio.com/v1/support
# then open https://dl-staging.getreelstudio.com/admin/support and paste the staging admin secret
```

A build of the app reports to staging with `REELSTUDIO_SUPPORT_URL=https://dl-staging.getreelstudio.com/v1/support`.

## Publishing source files

Source files are uploaded by hand, one folder per FFmpeg build (`source/ffmpeg-7.1.1-rs2/` today). A
folder is never changed once published (the files are cached for a year); a new build gets a new folder,
and the old one stays as long as an installer that bundles it is downloadable.

```
npx wrangler r2 object put reel-studio-installers/source/<release>/<file> --file <file> --content-type application/gzip --remote
```

## Releasing a version

The manifest lives in KV (`manifest`); the installers in R2 under `v<version>/`. Both are written by
`tools/publish.mjs` through the authenticated `/admin/*` routes (multipart upload, because one request to a
Worker carries at most 100 MB and wrangler refuses files over 300 MiB):

```
set DOWNLOADS_ADMIN_SECRET=…
node tools/publish.mjs release --version 0.1.5 --win "…\Reel Studio Setup 0.1.5.exe" --mac "…\Reel Studio 0.1.5.dmg" --mac-zip "…\Reel-Studio-0.1.5-arm64-mac.zip" --notes notes-0.1.5.md --dry-run
node tools/publish.mjs release --version 0.1.5 --win "…" --mac "…" --mac-zip "…" --notes notes-0.1.5.md
node tools/publish.mjs list
```

`release` hashes the files (SHA-256, and SHA-512 for the two the updater installs), uploads what is missing, and
publishes the manifest; the Worker refuses a manifest whose files are not in the bucket at the stated size. The
app sees the new version within five minutes. The Mac zip must hold the signed, notarized and **stapled** .app
(`ditto -c -k --sequesterRsrc --keepParent "Reel Studio.app" …zip`), not the dmg; without `--mac-zip` there is no
Mac update for that release. `--notes` puts this release's notes in front of the five newest in `latest.json`.
Old versions can be removed with `delete --key v0.1.2/…`.

Support: a buyer lost their link. Find the Checkout Session id in Stripe (Payments → the payment → Checkout
session, `cs_live_…`) and run `node tools/publish.mjs link --sid cs_live_…` to mint fresh links to send them.

## Staging

`npx wrangler deploy --env staging` runs the same code at `https://dl-staging.getreelstudio.com` with its own KV
namespace and R2 bucket (`reel-studio-installers-staging`), Stripe **test mode** secrets and no email binding.
Publish to it with `DOWNLOADS_API=https://dl-staging.getreelstudio.com` and its own `DOWNLOADS_ADMIN_SECRET`. A
build pointed at `https://dl-staging.getreelstudio.com/u/` updates itself from it, so a release can be proven end
to end (buy with Stripe's test card, update, cancel, be refused) before anyone sees it.

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
| `STRIPE_WEBHOOK_SECRET` | The signing secret of the Stripe webhook endpoint `https://dl.getreelstudio.com/stripe/webhook`. Events: `checkout.session.completed`, `checkout.session.async_payment_succeeded`, `customer.subscription.created`, `.updated`, `.deleted`, `charge.refunded`, `charge.dispute.created`, `charge.dispute.closed`. |
| `ADMIN_SECRET` | 32+ random bytes for `tools/publish.mjs`. Without it the `/admin` routes do not exist. It also opens the support dashboard. |
| `SUPPORT_ADMIN_SECRET` | Optional. 32+ random bytes that open the support dashboard (`/admin/support`) and nothing else, for someone who triages reports but does not publish releases. |

Bindings (`wrangler.jsonc`): KV `PURCHASES`, R2 `INSTALLERS`, and the `send_email` binding `EMAIL` (Cloudflare
Email Sending, enabled for getreelstudio.com on 2026-10-30; Workers Paid plan, 3,000 emails a month included).
Without the binding, receipts are skipped and "email me my link" degrades to "email support".

## Privacy

The Worker stores, per purchase: the Stripe Checkout Session id, the plan, Stripe's customer id, the subscription
or payment intent id, the time, and `HMAC(TOKEN_SECRET, email)`; per subscription or payment, its status. The Worker's own log lines carry a shortened session id and a file name, but
Cloudflare's request logs (`observability` in `wrangler.jsonc`) record every request's full URL, including the
token in a `/d/<token>/` link. The update feed takes the token in a header, so those URLs hold none. The download token holds the session id, the plan and an expiry.

A support report holds what the reporter typed (and their email, if they gave one), the app version and OS, the
diagnostics text and screenshot they chose to attach, and, when the app sent a key, the purchase's session id, plan
and whether it is entitled. Reports and screenshots expire after 180 days. The IP address is used for the rate limit
only (a counter key that expires within two hours) and is not stored with the report.
