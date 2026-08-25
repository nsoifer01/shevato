# SEO and visibility notes

This directory holds copies of the site's shared JSON-LD nodes, plus the
conventions for keeping metadata consistent across new pages.

## Files

- `organization.jsonld` - the Shevato LLC `Organization` node. Same
  `@id` (`https://shevato.com/#organization`) is used everywhere so
  multiple pages contribute facts about a single entity rather than
  fragmenting the graph.
- `website.jsonld` - the `WebSite` node, references the Organization
  as its publisher.

**`home.html` is the source of truth, not these files.** Nothing loads them
at runtime; pages inline their JSON-LD in a
`<script type="application/ld+json">` block in `<head>`. Each file here must
deep-equal the node with the matching `@id` that `home.html` actually emits
(`@context` aside, which a standalone fragment needs and an embedded node
inherits).

`tests/static/seo-jsonld-parity.test.mjs` enforces exactly that. To change a
shared node, edit the page and re-copy the node out of it. Editing a fragment
on its own will fail the test - which is the point: both files silently drifted
out of sync for three and a half months before that check existed.

## Per-page metadata checklist

When adding a new HTML page, the head should include:

1. `<html lang="...">` - set explicitly (`en`, `he`, etc.).
2. `<meta charset="utf-8">` and `<meta name="viewport" ...>` first,
   before any external script or title.
3. `<title>` - unique per page, ~60 chars, descriptive.
4. `<meta name="description">` - unique per page, ~155 chars.
5. `<meta name="robots" content="index, follow, max-image-preview:large">`
   on indexable pages; `noindex, follow` on redirect/404 pages.
6. `<meta name="author" content="Shevato LLC">`.
7. `<link rel="canonical" href="https://shevato.com/...">` -
   absolute URL, must equal the indexable URL.
8. Open Graph: `og:title`, `og:description`, `og:type`, `og:url`,
   `og:image`, `og:image:type`, `og:image:alt`, `og:site_name`,
   `og:locale`. Keep `og:url` consistent with `canonical`.
9. Twitter Card: `twitter:card`, `twitter:title`, `twitter:description`,
   `twitter:image`, `twitter:site`.
10. Resource hints: `<link rel="preconnect" ...>` for any third-party
    origin used later in the page (gstatic, googletagmanager, cdnjs).
11. JSON-LD: `WebPage` referencing the sitewide `WebSite`/`Organization`,
    plus `BreadcrumbList` if the page is more than one click from home.

## Discoverability files

- `/sitemap.xml` - a sitemap INDEX referencing three sub-sitemaps: the
  hand-maintained `/sitemap-pages.xml` (marketing pages and app entry
  pages) plus the generated Rising Shows and Gym Tracker sitemaps. Add a
  new page's `<url>` to `sitemap-pages.xml` with its absolute canonical
  URL only. Never hand-edit a `lastmod`: `scripts/stamp-sitemap-index.mjs`
  (the last step of `npm run build:site`) stamps every page's `lastmod`
  from the last git commit that touched its HTML, and derives the index
  entries from the sub-sitemaps (the generated sitemaps carry no `lastmod`
  because a build date is not a content date, so their index entries have
  none either).
- `/robots.txt` - blanket allow with explicit disallows for
  repo-internal material that the deploy still serves (`/partials/`,
  `/sync-system/`, `/tests/`, `/scripts/`, per-app `tests/`, `e2e/`,
  `scripts/` and `experiments/`, Markdown files, package/Firebase
  config and the rule files). Disallow only affects crawling; the files
  stay fetchable. SEO-research bots (Ahrefs, Semrush) are
  intentionally permitted so external backlink tools can surface the
  site.

## Social preview image

Every marketing page and app entry page has its own generated card under
`/images/og/<slug>.png`, built from `assets/og/cards.json` (see
`assets/og/README.md` for the manifest, the builder and how to add one).
Only `home.html` and the Rising Shows Kometa sub-page
(`apps/rising-shows/kometa/index.html`) use the generic brand card
`/images/og-card.png`, and `moadon-alef.html` uses its own bilingual card
`/images/og-card-moadon-alef.png`. Every page declares `og:image:width`,
`og:image:height`, `og:image:type`, and `og:image:alt`.

When updating brand visuals, regenerate the cards and keep the
dimensions at exactly 1200x630 so Facebook, LinkedIn, Slack, and
WhatsApp render the preview without re-fetching to determine size.
