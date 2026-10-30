# Reel Studio sales site

Static pages, one stylesheet, no build step, no external scripts. Every link is relative, so the site works at a
domain root or under a subpath such as `/reel-studio-site/`.

| File | What |
|---|---|
| `index.html` | Product page: hero, screenshots, how it works, what you get, pricing, what you need, FAQ |
| `thanks.html` | Where both Stripe Payment Links redirect. Reads `?plan=once|monthly&session_id={CHECKOUT_SESSION_ID}` and asks the download server for the buyer's links |
| `update.html` | What the app's "Update available" card opens: the newest version for a browser that remembers its download code, else the "email me my link" form |
| `downloads.js` | Shared by the two pages: talks to `https://dl.getreelstudio.com` (see `worker/`) |
| `terms.html`, `privacy.html`, `refund.html` | Terms of sale, privacy policy, refund policy |
| `style.css` | All styling. Dark theme; the hero's raw-take timeline is pure CSS and stops under `prefers-reduced-motion` |
| `fonts/` | Geist and Geist Mono (variable woff2), served from this site so no page calls a font CDN. SIL OFL 1.1, see `fonts/OFL.txt` |
| `favicon.svg` | The site icon |
| `img/` | One real reel and the app photographed on it (see `img/CREDITS.md`); `hero-reel.mp4` is the muted loop in the hero phone. The landing page crops them in CSS (`.crop` with `--x/--y/--w/--h` in pixels of the 1280x820 original) |
| `worker/` | The Cloudflare Worker behind `dl.getreelstudio.com`: paid downloads, the update manifest, the release tool. Its own README |

## Publish on GitHub Pages

1. Create a public repository and push this folder to its `main` branch.
2. In the repository: Settings > Pages > Build and deployment > Source: **Deploy from a branch**, Branch: **main**,
   folder **/ (root)**. Save.
3. The site appears at `https://<user>.github.io/<repo>/` within a minute or two.
4. Custom domain (later): Settings > Pages > Custom domain, save it first, then add the DNS records GitHub shows and
   tick **Enforce HTTPS** once DNS resolves.

Preview locally with `python -m http.server 8000` in this folder and open `http://localhost:8000/`.

## Stripe

Set each Payment Link's "after payment" redirect to the thanks page on the published site:

- $99 link: `<site>/thanks.html?plan=once&session_id={CHECKOUT_SESSION_ID}`
- $20/month link: `<site>/thanks.html?plan=monthly&session_id={CHECKOUT_SESSION_ID}`

`{CHECKOUT_SESSION_ID}` is typed literally: Stripe replaces it. The thanks page uses it to fetch the buyer's
download links from the Worker.

Use `<site>/terms.html` and `<site>/privacy.html` for the Stripe ToS and privacy URLs.

## Placeholders to replace

Replace every occurrence across all `.html` files (for example `sed -i 's|#STRIPE_LINK_ONCE|https://buy.stripe.com/...|g' *.html`).

| Placeholder | Replace with | Where |
|---|---|---|
| `#STRIPE_LINK_ONCE` | The $99 one-time Payment Link URL | `index.html` |
| `#STRIPE_LINK_MONTHLY` | The $20/month Payment Link URL | `index.html` |
| `#STRIPE_PORTAL` | The Stripe Customer Portal login link | `thanks.html`, `refund.html` |
| `[LEGAL ENTITY NAME]` | The seller's legal name | every page |
| `[MAILING ADDRESS]` | The seller's support mailing address | `terms.html`, `privacy.html`, `refund.html` |
| `[SUPPORT EMAIL]` | The support email address (also used inside `mailto:` links) | every page |

The product name appears as the literal `Reel Studio` everywhere, so a rename is a single replace.

Check nothing is left: `grep -n "STRIPE_\|\[LEGAL ENTITY NAME\]\|\[MAILING ADDRESS\]\|\[SUPPORT EMAIL\]" *.html`

## Keep in sync with the app

The privacy policy's network list describes app version 0.1.2. Re-check it against the app whenever a release adds
or removes a network call.
