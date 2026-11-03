# Reel Studio posting server

The Cloudflare Worker that posts a finished reel to the buyer's YouTube channel. A separate Worker from the
downloads one (`../worker`), so a posting bug can't break downloads or updates. Staging only for now:
`https://post-staging.getreelstudio.com` (Worker `reel-studio-posting-staging`). Production
(`post.getreelstudio.com`) is added to `wrangler.jsonc` only once it is approved.

The app talks to it from its main process, never from the page. Google's tokens never leave this server: the app
holds only a session, and the video passes through one chunk at a time without being kept.

## How it works

1. **Sign in.** The app trades the purchase key (the download token from the receipt email, the same one the
   update feed takes) for a per-computer session: `POST /v1/sessions` with `Authorization: Bearer <key>`. The key is
   checked like the update feed does (signature under `TOKEN_SECRET`, its age ignored, then the purchase record and
   `entitlement()` from `../worker/src/records.ts`). D1 keeps only the session's SHA-256, at most 10 per purchase.
   Every later call sends the session, and every call that can connect or post checks the purchase again (cached a
   minute per isolate). Sign out, sign out everywhere, disconnect and cancel work even after a subscription ends.
2. **Connect YouTube.** The app asks for an attempt and opens our own `/oauth/youtube/begin?a=…&t=…` in the
   browser (`t` works once). That sets an HttpOnly cookie and sends the browser to Google with `state`, PKCE S256,
   `access_type=offline` and `prompt=select_account consent` (the account chooser, then the consent screen). Google
   sends it back to the callback, which checks the state, the cookie, the session and the purchase, trades the
   code, insists on `youtube.upload`, reads the channel (needs `youtube.readonly`, optional: without it we connect
   without the channel's name), and stores the tokens encrypted. The app polls the attempt every 2 seconds and learns the outcome there.
3. **Post.** `POST /v1/uploads` opens a YouTube resumable upload session (Private unless the person picked
   otherwise). The app sends the file in chunks with `PUT /v1/uploads/:id` and `Content-Range`; each one is
   forwarded to Google with the access token. Google's confirmed offset is the truth: the app always continues
   from the `received` we answer, and `GET /v1/uploads/:id` asks Google again after a dropped connection.
4. **Disconnect** revokes the grant at Google and deletes the tokens and the post history.

The full interface (every route, error code and page) is the contract the app is built against; `src/app.ts`
lists the routes.

**What is kept** (D1, `migrations/0001_init.sql`): sessions (a hash, the purchase id, Windows/Mac/Linux, times),
YouTube connections (granted scopes, channel id, name and handle, the tokens encrypted with AES-256-GCM under
`ENC_KEY`, each bound to its row), and upload rows (size, status, the video id and the privacy YouTube set). Never
the video, its title or its description. The purchases KV is the downloads Worker's and is only read
(`readOnly` in `src/db.ts`: Cloudflare has no read-only binding).

**Daily cron** (`17 4 * * *` UTC, `src/retention.ts`): purchases whose record is gone (the downloads Worker's
90-day retention, or `forget`) have their Google grants revoked and every row deleted; channels are re-read every
25 days, so a grant removed in Google's settings is noticed (and its data dropped) within 30 days; old attempts,
unfinished uploads, sessions unused for 180 days and rate-limit windows are cleared.

## Google setup

Google Cloud project with **YouTube Data API v3** enabled. OAuth consent screen: External; scopes
`https://www.googleapis.com/auth/youtube.upload` and `https://www.googleapis.com/auth/youtube.readonly`; while in
Testing, every person who connects must be a test user, and refresh tokens die after 7 days (the app then says
"connect again"). Credentials: an OAuth client of type **Web application** with this exact redirect URI:

```
https://post-staging.getreelstudio.com/v1/youtube/callback
```

(Production will add `https://post.getreelstudio.com/v1/youtube/callback`.) The project's upload quota is 100
`videos.insert` calls a day across every user; more needs the Quota Extension Form, which needs the audit.

If Google ever refuses PKCE for the web client, set the var `OAUTH_PKCE = "off"` in the staging env.

## Secrets

Set per environment with `npx wrangler secret put <NAME> --env staging` (or `wrangler secret bulk --env staging`
from stdin). Never in `wrangler.jsonc`.

| Name | What |
|---|---|
| `TOKEN_SECRET` | The SAME value as the downloads Worker of that environment: it checks the purchase keys |
| `ENC_KEY` | base64url of 32 random bytes. Encrypts Google tokens at rest. Changing it strands every stored connection (they need connecting again) |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | The web OAuth client. Unset: `/v1/health` says `"youtube": false` and connect and upload answer `503 not_configured` |

Missing `TOKEN_SECRET` or `ENC_KEY` answers `503 {"error":"not_configured","what":…}` on the routes that need it.

## Deploying staging

```
cd posting
npm ci
npx wrangler d1 migrations apply DB --env staging --remote   # after adding a migration
npm run deploy:staging
npm run tail:staging                                         # live logs
```

The staging D1 database is `reel-studio-posting-staging`; its id is in `wrangler.jsonc`. There is no plain
`deploy` script: `wrangler deploy` without `--env staging` would create an unrouted Worker from the local-only
top-level config.

Check it: `node tools/smoke.mjs --base https://post-staging.getreelstudio.com --key-file <file with a staging purchase key> --connect-check`
signs in, reads `/v1/me`, checks Google accepts the authorize URL (no `invalid_client` or `redirect_uri_mismatch`),
and signs out. Add `--upload <video.mp4> --title "…"` for a real upload (it uses one of the day's 100).

`tools/seed-connection.mjs` stores a refresh token got outside the Worker as a purchase's YouTube connection,
encrypted with the Worker's own code, so an upload can be proven before anyone clicks Connect in the app.

## Running it locally, with a fake Google

No Google account, no quota. `test/fake-google.ts` plays Google's OAuth, `channels.list` and resumable upload on
the same paths; `tools/fake-google-server.mjs` serves it.

1. `node tools/fake-google-server.mjs --port 8790` (add `--auto` to skip its Allow page). It prints the vars below.
2. `posting/.dev.vars` (gitignored):
   ```
   TOKEN_SECRET=<any 32+ characters>
   ENC_KEY=<base64url of 32 random bytes>
   GOOGLE_CLIENT_ID=fake-client-id
   GOOGLE_CLIENT_SECRET=fake-client-secret
   GOOGLE_AUTH_URL=http://127.0.0.1:8790/o/oauth2/v2/auth
   GOOGLE_TOKEN_URL=http://127.0.0.1:8790/token
   GOOGLE_REVOKE_URL=http://127.0.0.1:8790/revoke
   YOUTUBE_API_URL=http://127.0.0.1:8790/youtube/v3
   YOUTUBE_UPLOAD_URL=http://127.0.0.1:8790/upload/youtube/v3/videos
   ```
3. `npx wrangler d1 migrations apply DB --local`, then `node tools/dev-seed.mjs` (writes a test purchase into the
   local KV and prints its key), then `npm run dev` (port 8788).
4. App: `REELSTUDIO_POSTING=1` and `REELSTUDIO_POSTING_URL=http://127.0.0.1:8788`; paste the local key; Post to
   YouTube; Connect; Allow on the fake page; Post. `http://127.0.0.1:8790/__fake/state` shows what arrived.
   Without the app: `node tools/smoke.mjs --base http://127.0.0.1:8788 --key-file <key> --connect --upload <file>`.

The fake takes injected failures over HTTP (`POST /__fake/faults` with e.g. `{"on":"chunk","dropAfterBytes":3000000}`,
`POST /__fake/flags` with `{"quotaExceeded":true}`, `POST /__fake/revoke-all`); see the top of the runner.

## Tests

```
npm test           # vitest: D1 on node:sqlite, the fake Google, a purchases KV that throws on any write
npm run typecheck
```

There is no CI for this repo: run both before pushing.
