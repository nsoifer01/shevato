#!/usr/bin/env node
/**
 * Builds apps/trip-planner/data/airports.json from the OurAirports dataset.
 *
 * WHY A BUNDLED FILE AND NOT AN API: every airport autocomplete API worth
 * using (Amadeus, AviationStack, Duffel) needs a secret key. Trip Planner is a
 * static client-side app with no backend of its own, so a key would either sit
 * in the page source or need a proxy function built and maintained for a list
 * that changes a few times a year. OurAirports is public domain, so we ship a
 * filtered copy instead: no key, no rate limit, no third-party downtime, and
 * the picker keeps working offline (which is the state you are most likely to
 * be in at an airport).
 *
 * THE FILTER: the raw file is ~86k rows and 12 MB, almost all of it airstrips
 * and heliports nobody books a seat on. Keeping only large/medium airports
 * that have an IATA code AND scheduled service leaves ~3.3k rows, which is
 * every airport a traveller can actually fly into.
 *
 * Re-run occasionally (the upstream data is community-maintained and drifts):
 *   npm run build:trip-planner:airports
 */

import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '../data/airports.json');

const AIRPORTS_URL = 'https://davidmegginson.github.io/ourairports-data/airports.csv';
const COUNTRIES_URL = 'https://davidmegginson.github.io/ourairports-data/countries.csv';

const KEEP_TYPES = new Set(['large_airport', 'medium_airport']);

/**
 * Minimal RFC 4180 CSV parser. OurAirports quotes any field containing a comma
 * and escapes a literal quote by doubling it, which `split(',')` gets wrong on
 * roughly one row in twelve ("Chicago O'Hare International Airport, Terminal
 * 5" and friends), so the parse is done properly rather than approximately.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { quoted = false; }
      } else { field += c; }
      continue;
    }
    if (c === '"') { quoted = true; continue; }
    if (c === ',') { row.push(field); field = ''; continue; }
    if (c === '\r') continue;
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; continue; }
    field += c;
  }
  if (field || row.length) { row.push(field); rows.push(row); }
  return rows;
}

/** Turns a parsed CSV (first row = header) into an array of plain objects. */
function toObjects(rows) {
  const head = rows[0] || [];
  return rows.slice(1)
    .filter(r => r.length === head.length)
    .map(r => Object.fromEntries(head.map((h, i) => [h, r[i]])));
}

async function fetchCsv(url) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);
  return toObjects(parseCsv(await res.text()));
}

/**
 * "Tokyo Haneda International Airport" -> "Tokyo Haneda International".
 * Every row would otherwise end in the same word; the picker adds it back at
 * display time. Worth ~25 KB across the file and it makes the rows readable.
 */
const trimAirportWord = name => String(name || '').replace(/\s+Airport$/i, '').trim();

/**
 * "Paris (Roissy-en-France, Val-d'Oise)" -> "Paris", "Ferno (VA)" -> "Ferno".
 * 233 rows carry an administrative parenthetical that is noise in a picker.
 * Commas are deliberately kept ("London, Essex" is both accurate and still
 * matches a search for London).
 */
const cleanCity = city => String(city || '').replace(/\s*\([^)]*\)\s*$/, '').trim();

// Generic aviation words carry no signal as an ALIAS (every row would match
// "international"), so they are dropped from alt even when the name happens
// not to contain them. "New" is deliberately NOT here: it is load-bearing in
// EWR's "New York City" alias.
const ALT_STOPWORDS = new Set([
  'airport', 'airports', 'airfield', 'aerodrome', 'airbase', 'aeropuerto',
  'international', 'intl', 'regional', 'municipal', 'national', 'terminal', 'field',
]);

/**
 * Upstream `keywords` holds the alternate names a traveller actually types:
 * NRT is keyworded "Tokyo" though its municipality is Narita, EWR is
 * keyworded "New York City", and the metro codes (TYO, NYC, PAR, LON) are
 * real search terms. This text is MATCH-ONLY and never displayed, so it is
 * filtered hard:
 *   - non-Latin scripts are dropped (the UI is English, and the CJK aliases
 *     alone cost ~40 KB to serve a query nobody here can type)
 *   - it is reduced to WORDS not already in the name or city. NRT's raw
 *     keywords repeat "Tokyo" three times across four phrases; since the
 *     picker only ever substring-matches this field, one copy does the same
 *     job. Phrase-level dedup left the file 33 KB larger (gzipped) for no
 *     extra match.
 */
function altTerms(keywords, name, city) {
  const have = new Set(`${name} ${city}`.toLowerCase().split(/[^a-z0-9]+/i).filter(Boolean));
  const words = String(keywords || '')
    .split(',')
    .map(t => t.trim())
    .filter(t => /^[\x20-\x7EÀ-ɏ'.-]+$/.test(t))
    .flatMap(t => t.split(/\s+/))
    .map(w => w.replace(/^[^\w'-]+|[^\w'-]+$/g, ''))
    .filter(w => w.length >= 2 && w.length <= 24)
    .filter(w => !have.has(w.toLowerCase()) && !ALT_STOPWORDS.has(w.toLowerCase()));
  return [...new Set(words)].join(' ');
}

async function main() {
  process.stdout.write('Fetching OurAirports data...\n');
  const [airports, countries] = await Promise.all([fetchCsv(AIRPORTS_URL), fetchCsv(COUNTRIES_URL)]);

  const countryName = new Map(countries.map(c => [c.code, c.name]));

  const rows = airports
    .filter(a => a.iata_code && KEEP_TYPES.has(a.type) && a.scheduled_service === 'yes')
    .map(a => {
      const name = trimAirportWord(a.name);
      const city = cleanCity(a.municipality);
      return {
        iata: a.iata_code.toUpperCase(),
        name,
        city,
        cc: (a.iso_country || '').toUpperCase(),
        lat: Number(a.latitude_deg),
        lon: Number(a.longitude_deg),
        big: a.type === 'large_airport' ? 1 : 0,
        alt: altTerms(a.keywords, name, city),
      };
    })
    .filter(a => a.iata.length === 3 && Number.isFinite(a.lat) && Number.isFinite(a.lon))
    // Stable, diff-friendly order. The picker scores its own results, so file
    // order is for humans reading the committed JSON, not for ranking.
    .sort((a, b) => a.iata.localeCompare(b.iata));

  // Only the countries actually referenced, so the map does not carry 250
  // entries for a list that reaches about 200 of them.
  const used = [...new Set(rows.map(r => r.cc))].sort();
  const cc = Object.fromEntries(used.map(c => [c, countryName.get(c) || c]));

  const payload = {
    source: 'OurAirports (ourairports.com), public domain',
    note: 'Large and medium airports with an IATA code and scheduled service. Rebuild with npm run build:trip-planner:airports',
    fields: ['iata', 'name', 'city', 'cc', 'lat', 'lon', 'big', 'alt'],
    countries: cc,
    rows: rows.map(r => [r.iata, r.name, r.city, r.cc, r.lat, r.lon, r.big, r.alt]),
  };

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, JSON.stringify(payload), 'utf8');

  const bytes = Buffer.byteLength(JSON.stringify(payload));
  process.stdout.write(`Wrote ${OUT}\n  ${rows.length} airports, ${used.length} countries, ${(bytes / 1024).toFixed(0)} KB\n`);
}

main().catch(err => { process.stderr.write(`build-airports failed: ${err.message}\n`); process.exit(1); });
