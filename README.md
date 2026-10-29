# Reel Studio sales site

Static pages, one stylesheet, no build step, no external scripts. Every link is relative, so the site works at a
domain root or under a subpath such as `/reel-studio-site/`.

| File | What |
|---|---|
| `index.html` | Product page: hero, screenshots, how it works, what you get, pricing, what you need, FAQ |
| `thanks.html` | Where both Stripe Payment Links redirect. Reads `?plan=once` or `?plan=monthly` |
| `terms.html`, `privacy.html`, `refund.html` | Terms of sale, privacy policy, refund policy |
| `style.css` | All styling |
| `img/` | Screenshots copied from the app repo's `docs/images/` (see `img/CREDITS.md`) |

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

- $99 link: `<site>/thanks.html?plan=once`
- $20/month link: `<site>/thanks.html?plan=monthly`

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
