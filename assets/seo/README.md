# SEO and visibility notes

This directory holds the canonical JSON-LD fragments referenced from
the site's HTML pages, plus the conventions for keeping metadata
consistent across new pages.

## Files

- `organization.jsonld` — the Shevato LLC `Organization` node. Same
  `@id` (`https://shevato.com/#organization`) is used everywhere so
  multiple pages contribute facts about a single entity rather than
  fragmenting the graph.
- `website.jsonld` — the `WebSite` node, references the Organization
  as its publisher.

These files are reference templates, not loaded at runtime. Pages
inline the relevant subset directly in a `<script type="application/ld+json">`
block in `<head>`.

## Resource hints template

Copy this block verbatim into any new marketing page `<head>`. It covers all third-party origins
used by the site and is safe to include even if a page doesn't use all of them.

```html
<!-- Resource hints -->
<link rel="preconnect" href="https://www.gstatic.com" crossorigin>
<link rel="preconnect" href="https://www.googletagmanager.com" crossorigin>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="dns-prefetch" href="https://www.google-analytics.com">
```

`preconnect` eliminates the TCP/TLS handshake cost for origins that load scripts or fonts in the
same request. `dns-prefetch` is a lighter hint for origins that may be contacted later (GA's
measurement endpoint is not on the critical path but benefits from a pre-resolved hostname).

## Per-page metadata checklist

When adding a new HTML page, the head should include:

1. `<html lang="...">` — set explicitly (`en`, `he`, etc.).
2. `<meta charset="utf-8">` and `<meta name="viewport" ...>` first,
   before any external script or title.
3. `<title>` — unique per page, ~60 chars, descriptive.
4. `<meta name="description">` — unique per page, ~155 chars.
5. `<meta name="robots" content="index, follow, max-image-preview:large">`
   on indexable pages; `noindex, follow` on redirect/404 pages.
6. `<meta name="author" content="Shevato LLC">`.
7. `<link rel="canonical" href="https://shevato.com/...">` —
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

- `/sitemap.xml` — lists all indexable pages with absolute URLs and
  `lastmod` dates. Update `lastmod` whenever the visible content of a
  page changes (not on every commit).
- `/robots.txt` — blanket allow with explicit disallows for
  repo-internal directories (`/partials/`, `/sync-system/`, etc.) and
  Firebase rule files. SEO-research bots (Ahrefs, Semrush) are
  intentionally permitted so external backlink tools can surface the
  site.

## Social preview image

The site-wide OG card is `/images/og-card.png` (1200×630, PNG). All
marketing pages and app `index.html` files reference it via `og:image`
and `twitter:image`. Pages also declare `og:image:width`,
`og:image:height`, `og:image:type`, and `og:image:alt`.

The `moadon-alef.html` landing has its own bilingual OG card at
`/images/og-card-moadon-alef.png`.

When updating brand visuals, regenerate both cards and keep the
dimensions at exactly 1200×630 so Facebook, LinkedIn, Slack, and
WhatsApp render the preview without re-fetching to determine size.
