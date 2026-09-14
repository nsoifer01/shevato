# Third-party mirror for the browser suites

The CDN assets the site loads, stored byte for byte so the browser suites
never depend on the live internet. `tests/browser/third-party.mjs` serves them
to every page `cdp.mjs` opens; any other third-party request is refused.

Refresh with:

```bash
node tests/browser/refresh-third-party.mjs
```

`tests/static/browser-third-party.test.mjs` fails, naming that command, when
the site references a CDN asset that is not here. `manifest.json` records each
file's source URL, content type and SHA-256.

Never served to site visitors: `tests/` is outside the Netlify publish
directory (`scripts/build-publish-dir.mjs`).

| Source | What | Licence |
| --- | --- | --- |
| `www.gstatic.com/firebasejs/10.7.1/` | Firebase JS SDK (app, auth, firestore) | Apache-2.0 |
| `fonts.googleapis.com`, `fonts.gstatic.com` | Raleway, Inter, Outfit, Space Grotesk, JetBrains Mono (stylesheets and woff2) | SIL Open Font License 1.1 |
| `cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/` | Font Awesome Free (CSS, webfonts) | CSS: MIT; fonts: SIL OFL 1.1 |
