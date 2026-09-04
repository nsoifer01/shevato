#!/usr/bin/env node
// Stamp partials/*.html into every page that includes them, at deploy time.
//
// Why. Until 2026-09-04 the site's header and footer reached the page only
// through `jQuery.load('/partials/header.html')` in assets/js/main.js, and
// robots.txt disallowed /partials/. Google's rendering service does not
// fetch robots-blocked subresources, so every page it rendered had no
// header and no footer: no nav, and six of the eight app pages left with
// zero internal outbound links. Unblocking the path in robots.txt fixes the
// symptom; this script removes the class of problem, by putting the markup
// in the HTML before it ever leaves the server.
//
// It also buys a blocking round trip back on every page load, and removes
// the layout shift the injection caused.
//
// How. `<div data-include="header"></div>` becomes
// `<div data-include-inlined="header">…partial…</div>`. main.js activates
// either form (see `activateInclude`), so the runtime fetch stays available
// as the local-dev path: a plain static server over the repo still works,
// because the repo files are never rewritten in a working clone unless the
// build is run there.
//
// Runs inside `npm run build:site`, which Netlify executes in a throwaway
// clone. Rewriting tracked files during the build is the same thing
// scripts/stamp-sitemap-index.mjs already does to sitemap-pages.xml.
//
// Idempotent: a page already carrying the inlined form is left alone, so
// running the build twice in a working clone cannot double-stamp.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Replace every `<div data-include="NAME"></div>` in `html` with the same
 * div carrying `data-include-inlined="NAME"` and the partial's markup.
 *
 * `partials` maps a partial name to its markup. A `data-include` naming a
 * partial that is not in the map is left untouched and reported, rather
 * than silently emptied.
 *
 * Returns { html, inlined: string[], missing: string[] }.
 */
export function inlinePartials(html, partials, { indent = '  ' } = {}) {
  const inlined = [];
  const missing = [];

  // Any EMPTY div whose attributes include data-include. Other attributes are
  // preserved in place: apps/mario-kart carries
  // `<div data-include="footer" class="mario-kart-footer">`, and dropping that
  // class would unstyle its footer.
  const out = html.replace(
    /([ \t]*)<div\s+([^<>]*?)\s*>\s*<\/div>/g,
    (whole, lead, attrs) => {
      const named = attrs.match(/\bdata-include="([A-Za-z0-9._-]+)"/);
      if (!named) return whole;
      const name = named[1];
      if (!Object.prototype.hasOwnProperty.call(partials, name)) {
        missing.push(name);
        return whole;
      }
      inlined.push(name);
      const keptAttrs = attrs.replace(/\bdata-include="/, 'data-include-inlined="');
      const body = partials[name]
        .replace(/\s+$/, '')
        .split('\n')
        .map((line) => (line.trim() ? lead + indent + line : line))
        .join('\n');
      return `${lead}<div ${keptAttrs}>\n${body}\n${lead}</div>`;
    }
  );

  return { html: out, inlined, missing };
}

/** Every partial in partials/, keyed by basename without the extension. */
export function readPartials(dir) {
  const partials = {};
  for (const file of fs.readdirSync(dir)) {
    if (!file.endsWith('.html')) continue;
    partials[file.slice(0, -'.html'.length)] = fs.readFileSync(path.join(dir, file), 'utf8');
  }
  return partials;
}

/** Every tracked HTML page that could carry an include. */
export function pagesToStamp(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'assets', 'apps-manifest.json'), 'utf8'));
  return [
    'index.html', 'home.html', 'work.html', 'apps.html', 'about.html',
    'contact.html', 'privacy.html', 'moadon-alef.html', '404.html',
    ...manifest.apps.map((a) => `apps/${a.slug}/index.html`),
    'apps/rising-shows/kometa/index.html'
  ].filter((p) => fs.existsSync(path.join(root, p)));
}

function main({ root = ROOT, log = console.log } = {}) {
  const partials = readPartials(path.join(root, 'partials'));
  let stamped = 0;
  let skipped = 0;

  for (const page of pagesToStamp(root)) {
    const abs = path.join(root, page);
    const before = fs.readFileSync(abs, 'utf8');
    const { html, inlined, missing } = inlinePartials(before, partials);

    for (const name of missing) {
      throw new Error(`${page}: data-include="${name}" has no partials/${name}.html`);
    }
    if (!inlined.length) { skipped += 1; continue; }

    fs.writeFileSync(abs, html);
    stamped += 1;
    log(`[inline-partials] ${page}: ${inlined.join(', ')}`);
  }

  log(`[inline-partials] stamped ${stamped} page(s); ${skipped} carried no include`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}

export { main };
