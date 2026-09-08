#!/usr/bin/env node
// Builds the Quote Scout marketplace rate dataset from authoritative public sources.
//
// Everything this script reads is published by the US government, needs no API
// key, and is free to redistribute. Nothing here is scraped from a commercial
// quote site and nothing is invented: every premium written out is a value CMS
// published in the Rate PUF for the plan year.
//
//   Rate PUF            premium per plan x rating area x age x tobacco
//   Plan Attributes PUF issuer, plan name, metal, type, deductible, MOOP
//   Service Area PUF    which counties (and partial-county ZIPs) a plan serves
//   CCIIO rating areas  county (or 3-digit ZIP) -> rating area, per state
//   Census ZCTA/county  ZIP -> county FIPS, so a shopper only has to type a ZIP
//
// The Exchange PUFs only cover states whose marketplace runs on HealthCare.gov.
// State-based exchanges (CA, NY, ...) publish their own data and are absent
// here; the generated meta.json records exactly which states came out, and the
// runtime refuses to guess about any state that is not in that list.
//
// Output lands in netlify/functions/lib/quotescout/data/ as gzipped JSON shards,
// one per state, plus a plain meta.json. The shards are committed so deploys
// stay fast and deterministic and so a CMS outage can never break a build.
//
// Usage: node --max-old-space-size=4096 scripts/build-quotescout-data.mjs [--year 2026]

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'netlify', 'functions', 'lib', 'quotescout', 'data');
const CACHE = path.join(ROOT, '.quotescout-build-cache');
const PUF = year => `https://download.cms.gov/marketplace-puf/${year}/`;
const GRA = state => `https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/${state.toLowerCase()}-gra`;
const ZCTA = 'https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt';
const UA = 'shevato-quotescout-dataset-build (+https://shevato.com/apps/quotescout/)';

const arg = name => { const i = process.argv.indexOf(`--${name}`); return i > 0 ? process.argv[i + 1] : undefined; };
const YEAR = Number(arg('year') || new Date().getUTCFullYear() + (new Date().getUTCMonth() >= 8 ? 1 : 0));
const log = (...parts) => console.log('[quotescout-data]', ...parts);

// ---------------------------------------------------------------- downloading

async function download(url, name) {
  const cached = path.join(CACHE, name);
  if (fs.existsSync(cached)) { log('cached', name); return fs.readFileSync(cached); }
  log('fetching', url);
  const response = await fetch(url, { headers: { 'User-Agent': UA }, redirect: 'follow' });
  if (!response.ok) throw new Error(`${url} responded ${response.status}`);
  const body = Buffer.from(await response.arrayBuffer());
  fs.mkdirSync(CACHE, { recursive: true });
  fs.writeFileSync(cached, body);
  return body;
}

// Minimal ZIP reader. The PUF archives hold exactly one deflated CSV, but the
// local header's sizes are unreliable when the writer used a data descriptor,
// so read the central directory instead. Adding a zip dependency to this repo
// is not an option, and shelling out to `unzip` would not be portable.
export function unzipSingle(buffer) {
  const eocd = buffer.lastIndexOf(Buffer.from('PK\x05\x06', 'latin1'));
  if (eocd < 0) throw new Error('not a zip archive');
  const entries = buffer.readUInt16LE(eocd + 10);
  let offset = buffer.readUInt32LE(eocd + 16);
  if (offset === 0xffffffff) throw new Error('ZIP64 archives are not supported by this reader');
  for (let i = 0; i < entries; i++) {
    if (buffer.readUInt32LE(offset) !== 0x02014b50) throw new Error('corrupt central directory');
    const method = buffer.readUInt16LE(offset + 10);
    const compressed = buffer.readUInt32LE(offset + 20);
    const nameLen = buffer.readUInt16LE(offset + 28);
    const extraLen = buffer.readUInt16LE(offset + 30);
    const commentLen = buffer.readUInt16LE(offset + 32);
    const local = buffer.readUInt32LE(offset + 42);
    const name = buffer.toString('latin1', offset + 46, offset + 46 + nameLen);
    if (name.endsWith('.csv')) {
      if (buffer.readUInt32LE(local) !== 0x04034b50) throw new Error('corrupt local header');
      const start = local + 30 + buffer.readUInt16LE(local + 26) + buffer.readUInt16LE(local + 28);
      const data = buffer.subarray(start, start + compressed);
      return method === 0 ? data : zlib.inflateRawSync(data, { maxOutputLength: 1024 * 1024 * 1024 });
    }
    offset += 46 + nameLen + extraLen + commentLen;
  }
  throw new Error('no CSV entry in archive');
}

// ------------------------------------------------------------------- csv/html

// Walks a CSV buffer line by line without materialising a multi-million element
// array of strings. `columns` selects the indices to keep, so the 280 MB Rate
// PUF never turns into 280 MB of retained JavaScript strings.
export function eachRow(buffer, onHeader, onRow) {
  let pos = 0, header = null;
  while (pos < buffer.length) {
    let nl = buffer.indexOf(0x0a, pos);
    if (nl < 0) nl = buffer.length;
    let end = nl;
    if (end > pos && buffer[end - 1] === 0x0d) end--;
    if (end > pos) {
      const line = buffer.toString('utf8', pos, end);
      if (!header) { header = splitCSV(line.replace(/^﻿/, '')); onHeader(header); }
      else onRow(line);
    }
    pos = nl + 1;
  }
}

export function splitCSV(line) {
  const out = [];
  let cur = '', quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (quoted) {
      if (c === '"') { if (line[i + 1] === '"') { cur += '"'; i++; } else quoted = false; }
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') { out.push(cur); cur = ''; }
    else cur += c;
  }
  out.push(cur);
  return out;
}

const stripTags = s => s.replace(/<[^>]+>/g, ' ')
  .replace(/&nbsp;/gi, ' ').replace(/&amp;/gi, '&').replace(/&#39;|&rsquo;/gi, "'")
  .replace(/&quot;/gi, '"').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>')
  .replace(/\s+/g, ' ').trim();

function htmlRows(html) {
  return [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)]
    .map(m => [...m[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/gi)].map(c => stripTags(c[1])));
}

// -------------------------------------------------------------- normalisation

// CMS writes county names the way a person would ("Brown", "St. Louis City");
// the Census writes "Brown County" and "St. Louis city". Both sides are reduced
// to the same key so the join is exact rather than fuzzy.
function countyKey(name) {
  return name.toLowerCase()
    .replace(/\b(county|parish|borough|census area|city and borough|municipality|municipio)\b/g, ' ')
    .replace(/\bst\.?\b/g, 'saint').replace(/\bste\.?\b/g, 'sainte')
    .replace(/[^a-z0-9]+/g, '');
}

// The CCIIO tables carry a handful of long-standing transcription errors:
// "Kosclusko" for Kosciusko, "Dubols" for Dubois, "Chautaugua" for Chautauqua,
// "Vermillion" for Vermilion, "Trail" for Traill. Rather than hard-code an alias
// list that rots, fold the characters those mistakes confuse and collapse
// doubled letters, then require the loose match to be unique within the state.
function looseCountyKey(name) {
  return countyKey(name)
    .replace(/rn/g, 'm').replace(/[l1]/g, 'i').replace(/0/g, 'o').replace(/q/g, 'g').replace(/5/g, 's')
    .replace(/(.)\1+/g, '$1');
}

// Last resort for a plain letter typo like "Deleware" for Delaware. Accepts a
// single substitution, insertion or deletion, and the caller still requires the
// match to resolve to exactly one rating area.
function editDistance1(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0, j = 0, edits = 0;
  while (i < short.length && j < long.length) {
    if (short[i] === long[j]) { i++; j++; continue; }
    if (++edits > 1) return false;
    if (short.length === long.length) i++;
    j++;
  }
  return edits + (long.length - j) + (short.length - i) <= 1;
}

// PUF money columns look like "$9,000 ", "" or "Not Applicable".
function money(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || /not applicable/i.test(text)) return null;
  const m = text.match(/^\$?\s*(\d[\d,]*)(?:\.(\d{1,2}))?\s*$/);
  if (!m) return null;
  const cents = Number(m[1].replace(/,/g, '')) * 100 + Number((m[2] || '0').padEnd(2, '0'));
  return Number.isSafeInteger(cents) ? cents : null;
}

const AGE_MIN = 18, AGE_MAX = 64, AGES = AGE_MAX - AGE_MIN + 1;

// Premiums rise smoothly with age, so a base value plus 46 small deltas in
// base36 is a fraction of the size of 47 independent decimal numbers. Nothing
// is rounded or interpolated: every value round-trips to the published cent.
function encodeAges(cents) {
  const parts = [cents[0].toString(36)];
  for (let i = 1; i < AGES; i++) parts.push((cents[i] - cents[i - 1]).toString(36));
  return parts.join('.');
}

// ------------------------------------------------------------------ the build

async function main() {
  log(`building plan year ${YEAR}`);

  const planAttributes = unzipSingle(await download(`${PUF(YEAR)}plan-attributes-puf.zip`, `${YEAR}-plan-attributes.zip`));
  const serviceAreas = unzipSingle(await download(`${PUF(YEAR)}service-area-puf.zip`, `${YEAR}-service-area.zip`));

  // ---- plans -------------------------------------------------------------
  // Only the standard on-exchange variants: those are what a shopper actually
  // sees on HealthCare.gov. CSR variants are priced identically and would just
  // duplicate every silver plan several times over.
  const plans = new Map();
  let importDate = '';
  {
    let idx = {};
    eachRow(planAttributes, header => { header.forEach((name, i) => { idx[name] = i; }); }, line => {
      const r = splitCSV(line);
      const at = name => r[idx[name]] ?? '';
      if (at('MarketCoverage') !== 'Individual') return;
      if (!/^Standard .* On Exchange Plan$/.test(at('CSRVariationType'))) return;
      const id = at('StandardComponentId');
      if (!/^[0-9]{5}[A-Z]{2}[0-9]{7}$/.test(id) || plans.has(id)) return;
      const dental = at('DentalOnlyPlan') === 'Yes';
      if (!importDate) {
        // PUF ImportDate is M/D/YYYY; store it as ISO so the runtime can format it.
        const m = at('ImportDate').match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
        importDate = m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : at('ImportDate').slice(0, 10);
      }
      plans.set(id, {
        s: at('StateCode'),
        n: at('PlanMarketingName'),
        i: at('IssuerMarketPlaceMarketingName'),
        m: at('MetalLevel'),
        t: at('PlanType'),
        a: at('ServiceAreaId'),
        d: dental ? 1 : 0,
        // Combined medical+drug limits when the issuer filed them that way,
        // otherwise the medical-only figure. Ambiguity stays null rather than
        // collapsing to the smaller of two different things.
        ded: money(at('TEHBDedInnTier1Individual')) ?? money(at('MEHBDedInnTier1Individual')) ?? (dental ? money(at('DEHBDedInnTier1Individual')) : null),
        moop: money(at('TEHBInnTier1IndividualMOOP')) ?? money(at('MEHBInnTier1IndividualMOOP')) ?? (dental ? money(at('DEHBInnTier1IndividualMOOP')) : null),
        dedCombined: at('TEHBDedInnTier1Individual').trim() ? 1 : 0,
        hsa: at('IsHSAEligible') === 'Yes' ? 1 : 0,
        tiers: at('MultipleInNetworkTiers') === 'Yes' ? 1 : 0,
        national: at('NationalNetwork') === 'Yes' ? 1 : 0,
      });
    });
  }
  log(`plans: ${plans.size} (${[...plans.values()].filter(p => !p.d).length} medical, ${[...plans.values()].filter(p => p.d).length} dental)`);

  // ---- service areas -----------------------------------------------------
  const areas = new Map();
  {
    let idx = {};
    eachRow(serviceAreas, header => { header.forEach((name, i) => { idx[name] = i; }); }, line => {
      const r = splitCSV(line);
      const at = name => r[idx[name]] ?? '';
      if (at('MarketCoverage') !== 'Individual') return;
      const key = `${at('StateCode')}|${at('ServiceAreaId')}`;
      let area = areas.get(key);
      if (!area) areas.set(key, area = { all: false, counties: new Set(), partial: {} });
      if (at('CoverEntireState') === 'Yes') { area.all = true; return; }
      const fips = at('County').trim();
      if (!/^\d{5}$/.test(fips)) return;
      area.counties.add(fips);
      // A partial county is only served in the listed ZIPs. Treating it as the
      // whole county would offer plans people cannot actually buy.
      if (at('PartialCounty') === 'Yes') {
        const zips = at('ZipCodes').split(/[^0-9]+/).filter(z => /^\d{5}$/.test(z));
        if (zips.length) area.partial[fips] = [...new Set([...(area.partial[fips] || []), ...zips])];
      }
    });
  }
  log(`service areas: ${areas.size}`);

  const states = [...new Set([...plans.values()].map(p => p.s))].sort();
  log(`states in PUF: ${states.length} (${states.join(' ')})`);

  // ---- rating areas ------------------------------------------------------
  // Rates are filed per rating area, and only CCIIO says which counties (or
  // 3-digit ZIP prefixes) sit in which area. Those pages are plain public-domain
  // HTML tables; the shape is asserted below so a redesign fails the build
  // loudly instead of silently producing a dataset with holes.
  // A few states (Alaska, for one) rate by 3-digit ZIP prefix instead of by
  // county, and the tables carry a column for each, so read both by header.
  const ratingAreas = new Map();
  for (const state of states) {
    const html = (await download(GRA(state), `gra-${state}.html`)).toString('utf8');
    const rows = htmlRows(html);
    const header = rows.find(r => r.length >= 2 && /rating area/i.test(r[0]));
    if (!header) throw new Error(`${state}: no rating-area table found`);
    const countyColumn = header.findIndex(h => /count(y|ies)/i.test(h));
    const zipColumn = header.findIndex(h => /zip/i.test(h));
    if (countyColumn < 0 && zipColumn < 0) throw new Error(`${state}: rating-area table has neither a county nor a ZIP column`);
    const map = { counties: new Map(), loose: new Map(), zips: new Map() };
    for (const row of rows) {
      const area = row[0]?.match(/rating area\s*(\d+)/i);
      if (!area) continue;
      const id = Number(area[1]);
      const county = countyColumn > 0 ? (row[countyColumn] || '').trim() : '';
      const zip = zipColumn > 0 ? (row[zipColumn] || '').trim() : '';
      if (county) {
        map.counties.set(countyKey(county), id);
        const loose = looseCountyKey(county);
        // Ambiguous loose keys are marked and never used as a fallback.
        map.loose.set(loose, map.loose.has(loose) && map.loose.get(loose) !== id ? null : id);
      }
      for (const m of zip.matchAll(/\b(\d{3})\b/g)) map.zips.set(m[1], id);
    }
    if (!map.counties.size && !map.zips.size) throw new Error(`${state}: rating-area table parsed to zero rows`);
    map.byZip = !map.counties.size;
    ratingAreas.set(state, map);
    log(`  ${state}: ${map.counties.size} county rows, ${map.zips.size} ZIP-prefix rows`);
  }

  // ---- ZIP -> county -----------------------------------------------------
  const zipToCounties = new Map();
  const countyNames = new Map();
  {
    const text = (await download(ZCTA, 'zcta-county.txt')).toString('utf8');
    for (const line of text.split(/\r?\n/).slice(1)) {
      if (!line) continue;
      const f = line.split('|');
      const zip = f[1], fips = f[9], name = f[10], land = Number(f[16] || 0);
      if (!/^\d{5}$/.test(zip) || !/^\d{5}$/.test(fips)) continue;
      countyNames.set(fips, name);
      const list = zipToCounties.get(zip) || [];
      list.push({ fips, land });
      zipToCounties.set(zip, list);
    }
  }
  log(`ZIP/county pairs: ${[...zipToCounties.values()].reduce((n, l) => n + l.length, 0)} across ${zipToCounties.size} ZIPs`);

  // Resolve every county the PUF references to a rating area now, at build
  // time, so a name that stopped matching is a build failure rather than a
  // shopper seeing "no plans" for a county that plainly has them.
  const stateFipsPrefix = new Map();
  for (const [fips, name] of countyNames) void name, stateFipsPrefix.set(fips.slice(0, 2), stateFipsPrefix.get(fips.slice(0, 2)) || new Set());
  // Exact name, then glyph-confusion, then a single-letter typo. Each fallback
  // must land on exactly one rating area or the county stays unresolved and the
  // build fails, which is the only safe outcome for a pricing dataset.
  const resolveArea = (map, name) => {
    const exact = map.counties.get(countyKey(name));
    if (exact) return exact;
    const loose = map.loose.get(looseCountyKey(name));
    if (loose) return loose;
    const key = looseCountyKey(name);
    const near = [...new Set([...map.loose].filter(([k, v]) => v && editDistance1(k, key)).map(([, v]) => v))];
    return near.length === 1 ? near[0] : undefined;
  };
  const countyArea = new Map();
  const unmatched = new Set();
  for (const [key, area] of areas) {
    const state = key.split('|')[0];
    const map = ratingAreas.get(state);
    if (!map || map.byZip) continue;
    for (const fips of area.counties) {
      if (countyArea.has(fips)) continue;
      const name = countyNames.get(fips);
      const hit = name ? resolveArea(map, name) : undefined;
      if (hit) countyArea.set(fips, hit);
      else unmatched.add(`${state}:${fips}:${name || 'unknown FIPS'}`);
    }
  }
  // Every unmatched county silently hides real plans from real shoppers, so
  // this is a build failure rather than a warning.
  if (unmatched.size) throw new Error(`${unmatched.size} counties have no rating area: ${[...unmatched].join(', ')}`);

  // ---- rates -------------------------------------------------------------
  const rates = new Map();
  {
    const rateBuffer = unzipSingle(await download(`${PUF(YEAR)}rate-puf.zip`, `${YEAR}-rate.zip`));
    log(`rate PUF: ${(rateBuffer.length / 1048576).toFixed(0)} MB`);
    let iPlan = -1, iArea = -1, iAge = -1, iRate = -1, iTobacco = -1, kept = 0;
    eachRow(rateBuffer, header => {
      iPlan = header.indexOf('PlanId'); iArea = header.indexOf('RatingAreaId'); iAge = header.indexOf('Age');
      iRate = header.indexOf('IndividualRate'); iTobacco = header.indexOf('IndividualTobaccoRate');
      if ([iPlan, iArea, iAge, iRate, iTobacco].some(i => i < 0)) throw new Error('Rate PUF columns changed');
    }, line => {
      const r = line.split(',');
      const id = r[iPlan];
      const plan = plans.get(id);
      if (!plan) return;
      // The Rate PUF's youngest and oldest buckets are labelled "0-14" and
      // "64 and over" rather than as plain numbers. Only the top bucket is an
      // adult age, and it is the filed rate for a 64-year-old.
      const raw = r[iAge];
      const age = raw === '64 and over' ? 64 : Number(raw);
      if (!Number.isInteger(age) || age < AGE_MIN || age > AGE_MAX) return;
      const area = Number((r[iArea] || '').replace(/\D+/g, ''));
      if (!area) return;
      const cents = Math.round(Number(r[iRate]) * 100);
      if (!Number.isSafeInteger(cents) || cents < 0) return;
      const tobacco = r[iTobacco] ? Math.round(Number(r[iTobacco]) * 100) : 0;
      let byPlan = rates.get(id);
      if (!byPlan) rates.set(id, byPlan = new Map());
      let vec = byPlan.get(area);
      if (!vec) byPlan.set(area, vec = { n: new Array(AGES).fill(-1), t: new Array(AGES).fill(0) });
      vec.n[age - AGE_MIN] = cents;
      vec.t[age - AGE_MIN] = Number.isSafeInteger(tobacco) && tobacco > 0 ? tobacco : 0;
      kept++;
    });
    log(`rate rows kept: ${kept}`);
  }

  // ---- emit --------------------------------------------------------------
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });

  const written = [];
  let totalPlans = 0, totalRates = 0;
  for (const state of states) {
    const map = ratingAreas.get(state);
    const shard = { state, year: YEAR, ra: {}, rz: {}, sa: {}, p: {}, r: {} };

    for (const [prefix, area] of map.zips) shard.rz[prefix] = area;

    for (const [key, area] of areas) {
      if (!key.startsWith(`${state}|`)) continue;
      const id = key.slice(state.length + 1);
      const counties = [...area.counties].filter(f => area.all || countyArea.has(f) || map.byZip).sort();
      shard.sa[id] = { all: area.all ? 1 : 0, c: counties, ...(Object.keys(area.partial).length ? { z: area.partial } : {}) };
    }

    for (const [id, plan] of plans) {
      if (plan.s !== state) continue;
      const byArea = rates.get(id);
      if (!byArea || !byArea.size) continue;
      const encoded = {};
      for (const [area, vec] of byArea) {
        // A plan missing any adult age in its filing cannot be priced honestly
        // for an arbitrary shopper, so it is dropped rather than interpolated.
        if (vec.n.some(v => v < 0)) continue;
        encoded[area] = { n: encodeAges(vec.n) };
        if (vec.t.some(v => v > 0) && vec.t.every(v => v > 0)) encoded[area].t = encodeAges(vec.t);
      }
      if (!Object.keys(encoded).length) continue;
      const { s, ...rest } = plan; void s;
      shard.p[id] = rest;
      shard.r[id] = encoded;
      totalPlans++;
      totalRates += Object.keys(encoded).length;
    }

    if (!map.byZip) {
      for (const areaId of Object.keys(shard.sa)) for (const fips of shard.sa[areaId].c) {
        const hit = countyArea.get(fips);
        if (hit) shard.ra[fips] = hit;
      }
      // Statewide plans still need every county in the state mapped.
      if (Object.values(shard.sa).some(a => a.all)) {
        for (const [fips, name] of countyNames) {
          if (shard.ra[fips] || fipsState(fips) !== state) continue;
          const hit = resolveArea(map, name);
          if (hit) shard.ra[fips] = hit;
        }
      }
    }

    if (!Object.keys(shard.p).length) { log(`  ${state}: no priceable plans, skipped`); continue; }
    const file = path.join(OUT, `${state}.json.gz`);
    fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(shard), { level: 9 }));
    written.push(state);
    log(`  ${state}: ${Object.keys(shard.p).length} plans, ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
  }

  // ZIP index, restricted to the states we can actually price.
  const covered = new Set(written);
  const zipIndex = {};
  for (const [zip, list] of zipToCounties) {
    const inCovered = list.filter(c => covered.has(fipsState(c.fips)));
    if (!inCovered.length) continue;
    // Largest shared land area first: that is the county a ZIP mostly sits in,
    // and it decides which county we suggest when we have to ask.
    inCovered.sort((a, b) => b.land - a.land);
    zipIndex[zip] = inCovered.map(c => c.fips);
  }
  fs.writeFileSync(path.join(OUT, 'zips.json.gz'), zlib.gzipSync(JSON.stringify(zipIndex), { level: 9 }));

  // Every ZIP in the country, mapped to its state, so a shopper in a state with
  // its own exchange gets told that rather than "ZIP not recognised".
  const zipStates = {};
  for (const [zip, list] of zipToCounties) {
    const state = fipsState(list[0].fips);
    if (state) zipStates[zip] = state;
  }
  fs.writeFileSync(path.join(OUT, 'zip-states.json.gz'), zlib.gzipSync(JSON.stringify(zipStates), { level: 9 }));

  const names = {};
  for (const zips of Object.values(zipIndex)) for (const fips of zips) names[fips] = countyNames.get(fips);
  fs.writeFileSync(path.join(OUT, 'counties.json.gz'), zlib.gzipSync(JSON.stringify(names), { level: 9 }));

  const meta = {
    planYear: YEAR,
    pufImportDate: importDate,
    generatedAt: new Date().toISOString().slice(0, 10),
    states: written,
    zips: Object.keys(zipIndex).length,
    zipsNationwide: Object.keys(zipStates).length,
    plans: totalPlans,
    planAreaRates: totalRates,
    ageRange: [AGE_MIN, AGE_MAX],
    sources: [
      { name: 'CMS Health Insurance Exchange Public Use Files', url: `https://download.cms.gov/marketplace-puf/${YEAR}/`, use: 'plan attributes, service areas, filed premiums' },
      { name: 'CMS CCIIO state geographic rating areas', url: 'https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-gra', use: 'county to rating area' },
      { name: 'US Census Bureau 2020 ZCTA to county relationship file', url: ZCTA, use: 'ZIP to county' },
    ],
  };
  fs.writeFileSync(path.join(OUT, 'meta.json'), `${JSON.stringify(meta, null, 2)}\n`);

  const bytes = fs.readdirSync(OUT).reduce((n, f) => n + fs.statSync(path.join(OUT, f)).size, 0);
  log(`done: ${written.length} states, ${totalPlans} plans, ${Object.keys(zipIndex).length} ZIPs, ${(bytes / 1048576).toFixed(2)} MB on disk`);
}

// FIPS state prefixes are stable; this avoids carrying a second lookup table.
const FIPS_STATE = { '01': 'AL', '02': 'AK', '04': 'AZ', '05': 'AR', '06': 'CA', '08': 'CO', '09': 'CT', 10: 'DE', 11: 'DC', 12: 'FL', 13: 'GA', 15: 'HI', 16: 'ID', 17: 'IL', 18: 'IN', 19: 'IA', 20: 'KS', 21: 'KY', 22: 'LA', 23: 'ME', 24: 'MD', 25: 'MA', 26: 'MI', 27: 'MN', 28: 'MS', 29: 'MO', 30: 'MT', 31: 'NE', 32: 'NV', 33: 'NH', 34: 'NJ', 35: 'NM', 36: 'NY', 37: 'NC', 38: 'ND', 39: 'OH', 40: 'OK', 41: 'OR', 42: 'PA', 44: 'RI', 45: 'SC', 46: 'SD', 47: 'TN', 48: 'TX', 49: 'UT', 50: 'VT', 51: 'VA', 53: 'WA', 54: 'WV', 55: 'WI', 56: 'WY', 60: 'AS', 66: 'GU', 69: 'MP', 72: 'PR', 78: 'VI' };
function fipsState(fips) { return FIPS_STATE[fips.slice(0, 2)] || ''; }

// Importable for verification tests; only the CLI entry point runs the build.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e); process.exit(1); });
}

export { main, PUF, AGE_MIN, AGE_MAX };
