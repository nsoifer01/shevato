# Social-share (Open Graph) card images

Every page on the site hand-authors its own `<title>`, `meta description`,
`canonical`, Open Graph, and Twitter tags directly in its `index.html`. They are
plain static HTML, so they are present in the initial server response and each
page already overrides the site default. The one thing that used to be shared
across every page was the preview **image** (`og:image` / `twitter:image`), which
all pointed at the generic blue homepage card `images/og-card.png`. Because social
platforms render the image as the dominant element of a link preview, every app
looked like the homepage. This folder fixes that by giving each page its own card.

## What's here

- `card.html` - a single 1200x630 template, filled via query string. Never
  linked at runtime; it exists only to be screenshotted at build time.
- `cards.json` - the manifest: one entry per page (title, subtitle, eyebrow,
  accent, output `slug`).
- `build-og-cards.mjs` - renders each manifest entry to `images/og/<slug>.png`
  with headless Chromium.

The generated PNGs live in `images/og/` and are **committed** (Netlify does not
run Chromium at deploy time, so the output cannot be built on the server).

## Regenerate the cards

```bash
npm run build:og-cards            # all cards
node assets/og/build-og-cards.mjs maptap-rivals   # just one
```

Then commit the changed PNGs.

## Add a card for a new page

1. Add an entry to `cards.json`:

   ```json
   {
     "slug": "my-new-app",
     "eyebrow": "Short label",
     "title": "My New App",
     "subtitle": "One-line tagline that fits on two lines",
     "accent": "#38bdf8"
   }
   ```

2. Run `npm run build:og-cards` and commit `images/og/my-new-app.png`.

3. In that page's `<head>`, point the image tags at the new card and make sure
   the rest of the preview metadata is page-specific (not inherited):

   ```html
   <title>My New App | Short tagline - Shevato</title>
   <meta name="description" content="..." />
   <link rel="canonical" href="https://shevato.com/apps/my-new-app/" />

   <meta property="og:title" content="My New App | Short tagline" />
   <meta property="og:description" content="..." />
   <meta property="og:type" content="website" />
   <meta property="og:url" content="https://shevato.com/apps/my-new-app/" />
   <meta property="og:image" content="https://shevato.com/images/og/my-new-app.png" />
   <meta property="og:image:width" content="1200" />
   <meta property="og:image:height" content="630" />

   <meta name="twitter:card" content="summary_large_image" />
   <meta name="twitter:title" content="My New App | Short tagline" />
   <meta name="twitter:description" content="..." />
   <meta name="twitter:image" content="https://shevato.com/images/og/my-new-app.png" />
   ```

   Always use absolute `https://shevato.com/...` URLs for the images - relative
   paths break when the crawler fetches the card off-site.

## After deploying

Social platforms cache previews aggressively. A page that was scraped before this
change will keep showing the old generic card until the platform re-scrapes. Force
a refresh with each platform's debugger:

- Facebook / Messenger / Instagram: https://developers.facebook.com/tools/debug/
- LinkedIn: https://www.linkedin.com/post-inspector/
- X (Twitter): post the link in a draft, or use the Card Validator
- Discord / Slack / Telegram: they cache by URL for a while; appending a harmless
  `?v=2` once is the quickest way to bust their cache.
