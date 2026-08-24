// Every tel: href on the site dials the right country and is a clean E.164
// URI. internal-links.test.mjs skips tel:/mailto: on purpose, which is how
// the moadon-alef footer shipped `tel:+1700701103` (a North American number
// for an Israeli 1-700 line; the page body dialled +972 1700 701 103) and the
// site footer shipped `tel:+1504-638-3370` (hyphens inside the URI, which
// some dialers mis-parse) next to contact.html's `tel:+15046383370`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

// Moadon Alef surfaces are Israeli (+972); everything else on the site is the
// Shevato LLC US number (+1).
const COUNTRY_CODE = (file) => (/moadon-alef/.test(file) ? '+972' : '+1');

const FILES = [
  ...readdirSync(REPO_ROOT).filter((f) => f.endsWith('.html')),
  ...readdirSync(join(REPO_ROOT, 'partials')).filter((f) => f.endsWith('.html')).map((f) => `partials/${f}`),
];

const telHrefs = (html) => [...html.matchAll(/href="(tel:[^"]*)"/g)].map((m) => m[1]);

test('tel: hrefs exist on the surfaces this test guards', () => {
  const all = FILES.flatMap((f) => telHrefs(readFileSync(join(REPO_ROOT, f), 'utf8')));
  assert.ok(all.length >= 4, `expected the footer, contact and moadon-alef tel: links, found ${all.length}`);
});

for (const file of FILES) {
  const hrefs = telHrefs(readFileSync(join(REPO_ROOT, file), 'utf8'));
  if (!hrefs.length) continue;
  test(`${file}: every tel: href is E.164 with the ${COUNTRY_CODE(file)} country code`, () => {
    const bad = hrefs.filter((h) => !/^tel:\+\d{8,15}$/.test(h) || !h.startsWith(`tel:${COUNTRY_CODE(file)}`));
    assert.deepEqual(bad, [], `bad tel: hrefs in ${file}`);
  });
}
