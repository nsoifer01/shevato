// The Chrome 99 crawler block (netlify/edge-functions/block-crawler.mjs).
//
// A wrong match costs a real visitor the whole site, so the fingerprint must
// need all three parts, and everything that is not a page must stay outside
// the edge function's path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import handler, { isBlockedCrawler, config } from '../../netlify/edge-functions/block-crawler.mjs';
import { classifyPath } from '../../scripts/netlify-ignore.mjs';

const CRAWLER_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36';
const CURRENT_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const MAC_99_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/99.0.4844.51 Safari/537.36';

const call = (ua, code) => handler(
  new Request('https://shevato.com/apps/rising-shows/shows/army-wives-tt0859592/', { headers: ua ? { 'user-agent': ua } : {} }),
  { geo: code === undefined ? {} : { country: { code } } },
);

test('the exact fingerprint is blocked', () => {
  assert.equal(isBlockedCrawler(CRAWLER_UA, 'CN'), true);
});

test('each part of the fingerprint is required', () => {
  assert.equal(isBlockedCrawler(CRAWLER_UA, 'US'), false, 'same browser outside China');
  assert.equal(isBlockedCrawler(CRAWLER_UA, undefined), false, 'no geo');
  assert.equal(isBlockedCrawler(CURRENT_UA, 'CN'), false, 'current Chrome in China');
  assert.equal(isBlockedCrawler(MAC_99_UA, 'CN'), false, 'same build on macOS');
  assert.equal(isBlockedCrawler(CRAWLER_UA.replace('99.0.4844.51', '99.0.4844.82'), 'CN'), false, 'another Chrome 99 build');
  assert.equal(isBlockedCrawler('', 'CN'), false);
  assert.equal(isBlockedCrawler(null, 'CN'), false);
});

test('the crawler gets an uncacheable, unindexable 403', async () => {
  const res = await call(CRAWLER_UA, 'CN');
  assert.equal(res.status, 403);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.equal(res.headers.get('x-robots-tag'), 'noindex');
});

test('everyone else passes straight through to the page', async () => {
  assert.equal(await call(CURRENT_UA, 'CN'), undefined);
  assert.equal(await call(CRAWLER_UA, 'US'), undefined);
  assert.equal(await call(CRAWLER_UA, undefined), undefined);
  assert.equal(await call(undefined, 'CN'), undefined);
});

test('static files and functions are outside the edge function', () => {
  assert.equal(config.path, '/*');
  for (const p of ['/.netlify/*', '/assets/*', '/images/*', '/*.js', '/*.css', '/*.json', '/*.xml', '/*.txt', '/*.webmanifest', '/*.png', '/*.woff2']) {
    assert.ok(config.excludedPath.includes(p), `${p} excluded`);
  }
  assert.ok(!config.excludedPath.some((p) => p.endsWith('.html') || p.endsWith('/')), 'pages are never excluded');
});

test('a change to the edge function always triggers a Netlify build', () => {
  assert.equal(classifyPath('netlify/edge-functions/block-crawler.mjs').relevant, true);
});
