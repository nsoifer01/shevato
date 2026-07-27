#!/usr/bin/env node
/**
 * PROTOTYPE harness. Run the extractor against a real confirmation:
 *
 *   npm run proto:extract -- ~/Downloads/ba-confirmation.pdf
 *   npm run proto:extract -- some-confirmation.txt
 *   pbpaste | npm run proto:extract -- -          (read text on stdin)
 *
 * Add --text to dump the extracted text, which is the fastest way to see why
 * a PDF read badly.
 *
 * PDF SUPPORT IS BEST-EFFORT AND DELIBERATELY DEPENDENCY-FREE. It inflates
 * FlateDecode content streams with node's own zlib and pulls the text-showing
 * operators out. That covers the ordinary "confirmation email printed to PDF"
 * case; it does NOT cover scanned documents (no text layer to find at all) or
 * PDFs that pack their objects into compressed object streams. The real app
 * would use pdf.js, vendored the way Leaflet already is - the point of this
 * harness is to measure the EXTRACTOR's hit rate, not to ship a PDF reader.
 */

import { readFileSync } from 'node:fs';
import { inflateSync, inflateRawSync } from 'node:zlib';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractBookings } from './extract-booking.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

function loadAirports() {
  const p = JSON.parse(readFileSync(resolve(HERE, '../../data/airports.json'), 'utf8'));
  return p.rows.map(r => ({
    iata: r[0], name: r[1], city: r[2], cc: r[3], lat: r[4], lon: r[5], big: r[6] === 1, alt: r[7],
  }));
}

/** Unescapes a PDF literal string: \( \) \\ \n \t and \ddd octal. */
function pdfString(s) {
  return s.replace(/\\([nrtbf()\\]|[0-7]{1,3})/g, (_, c) => {
    const simple = { n: '\n', r: '', t: ' ', b: '', f: '', '(': '(', ')': ')', '\\': '\\' };
    if (simple[c] !== undefined) return simple[c];
    return String.fromCharCode(parseInt(c, 8));
  });
}

/** Pulls text out of one decoded content stream via Tj / TJ / ' / " operators. */
function textFromStream(content) {
  const out = [];
  // (literal) Tj    and    [(a) -20 (b)] TJ
  // Tm counts as a line break too: plenty of generators position every line
  // with a text matrix and never emit Td at all, which collapsed a whole
  // document onto one line.
  const re = /\((?:\\.|[^\\()])*\)|\bTJ\b|\bTj\b|\bT\*\b|\bTD\b|\bTd\b|\bTm\b|\bET\b/g;
  let line = [];
  let m;
  while ((m = re.exec(content))) {
    const tok = m[0];
    if (tok.startsWith('(')) line.push(pdfString(tok.slice(1, -1)));
    else if (tok === 'T*' || tok === 'TD' || tok === 'Td' || tok === 'Tm' || tok === 'ET') {
      if (line.length) { out.push(line.join('')); line = []; }
    }
  }
  if (line.length) out.push(line.join(''));
  return out.join('\n');
}

function pdfToText(buf) {
  const raw = buf.toString('latin1');
  const chunks = [];
  const re = /stream\r?\n?([\s\S]*?)endstream/g;
  let m;
  while ((m = re.exec(raw))) {
    const bytes = Buffer.from(m[1], 'latin1');
    let decoded = null;
    for (const fn of [inflateSync, inflateRawSync]) {
      try { decoded = fn(bytes).toString('latin1'); break; } catch { /* not this codec */ }
    }
    if (!decoded && /\bT[Jj]\b/.test(m[1])) decoded = m[1];   // uncompressed stream
    if (decoded && /\bT[Jj]\b/.test(decoded)) chunks.push(textFromStream(decoded));
  }
  return chunks.join('\n');
}

async function readInput(arg) {
  if (arg === '-') {
    const bits = [];
    for await (const c of process.stdin) bits.push(c);
    return Buffer.concat(bits).toString('utf8');
  }
  const buf = readFileSync(arg);
  if (buf.slice(0, 5).toString() === '%PDF-') {
    const text = pdfToText(buf);
    if (!text.trim()) {
      process.stderr.write(
        'Could not find a text layer in that PDF.\n'
        + 'Either it is a scan (an image of a document, which needs OCR and is out of\n'
        + 'scope), or it packs its objects in a way this dependency-free reader does not\n'
        + 'handle. Try: open it, select all, copy, then `pbpaste | npm run proto:extract -- -`\n');
      process.exit(2);
    }
    return text;
  }
  return buf.toString('utf8');
}

const C = { dim: '\x1b[2m', b: '\x1b[1m', g: '\x1b[32m', y: '\x1b[33m', r: '\x1b[31m', off: '\x1b[0m' };
const tint = { high: C.g, medium: C.y, low: C.r };

const args = process.argv.slice(2);
const showText = args.includes('--text');
const target = args.find(a => a !== '--text');

if (!target) {
  process.stderr.write('usage: npm run proto:extract -- <file.pdf|file.txt|->  [--text]\n');
  process.exit(1);
}

const text = await readInput(target);
if (showText) {
  process.stdout.write(`${C.dim}--- extracted text ---${C.off}\n${text}\n${C.dim}--- end ---${C.off}\n\n`);
}

const { proposals, stats } = extractBookings(text, { airports: loadAirports() });

process.stdout.write(`${C.b}${target}${C.off}  ${C.dim}(${stats.lines} non-empty lines)${C.off}\n\n`);

if (!proposals.length) {
  process.stdout.write(`${C.r}Nothing could be read with confidence.${C.off}\n`
    + `${C.dim}Re-run with --text to see what the reader actually got.${C.off}\n`);
  process.exit(0);
}

for (const p of proposals) {
  const t = tint[p.confidence] || '';
  process.stdout.write(`${t}${C.b}${p.kind.toUpperCase()}  confidence: ${p.confidence}${C.off}\n`);
  for (const [k, v] of Object.entries(p.item)) {
    if (v === '' || v == null) continue;
    process.stdout.write(`  ${k.padEnd(14)} ${v}\n`);
  }
  if (p.evidence.length) {
    process.stdout.write(`\n  ${C.dim}read from:${C.off}\n`);
    for (const e of p.evidence) {
      process.stdout.write(`  ${C.dim}  ${String(e.field).padEnd(13)} line ${String(e.line + 1).padStart(3)}  ${e.raw.slice(0, 68)}${C.off}\n`);
    }
  }
  if (p.warnings.length) {
    process.stdout.write(`\n  ${C.y}check these:${C.off}\n`);
    for (const w of p.warnings) process.stdout.write(`  ${C.y}  - ${w}${C.off}\n`);
  }
  process.stdout.write('\n');
}
