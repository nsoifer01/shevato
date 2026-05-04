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

## Known follow-ups

- The site's social-preview image is currently the SVG logo
  (`/images/full-logo.svg`). Most platforms (Twitter/X, Facebook,
  LinkedIn) render PNG/JPG previews better than SVG. Producing a
  dedicated 1200×630 PNG OG image and pointing all `og:image` /
  `twitter:image` tags at it would noticeably improve the way shared
  links render.
- Adding a `og:image:width` / `og:image:height` pair (once a sized
  raster image exists) lets Slack and other crawlers reserve layout
  space and avoid jank.
