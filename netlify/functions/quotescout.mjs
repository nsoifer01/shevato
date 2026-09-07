import { randomUUID } from 'node:crypto';
import { VERTICALS } from '../../apps/quotescout/js/model.js';
import { validateRequest } from './lib/quotescout/validation.mjs';
import { createAdapters } from './lib/quotescout/adapters.mjs';
import { createEngine, BoundedCache, hash } from './lib/quotescout/engine.mjs';
import { getStore, validateConfig, reserveQuota } from './lib/quotescout/store.mjs';
import { readJSON, ERRORS } from './lib/quotescout/http.mjs';
const cache = new BoundedCache(), enrichment = new BoundedCache(500);
const HEADERS = { 'Cache-Control': 'private, no-store, max-age=0', 'Netlify-CDN-Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Vary': 'Origin', 'Content-Type': 'application/json' };
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: HEADERS });
export function createHandler({ storeFactory = getStore, fetcher = fetch, env = process.env, log = event => console.info(JSON.stringify(event)) } = {}) {
  const engines = new Map();
  return async (req, context = {}) => {
    // Runtime deploy metadata is authoritative; build environment variables
    // are not guaranteed to exist inside a deployed function.
    const runtimeEnv = { ...env, CONTEXT: context.deploy?.context || env.CONTEXT };
    const local = runtimeEnv.CONTEXT !== 'production';
    const origin = req.headers.get('origin');
    let originOK = origin === 'https://shevato.com';
    if (local && env.QUOTESCOUT_ALLOW_LOCAL_PROVIDERS === '1') { try { const u = new URL(origin); originOK ||= ['localhost','127.0.0.1'].includes(u.hostname) && ['http:','https:'].includes(u.protocol); } catch { /* invalid */ } }
    if (req.method !== 'GET' && req.method !== 'POST') return json({ message: 'Method not allowed.' }, 405);
    if (req.method === 'POST' && !originOK) return json({ message: 'Open QuoteScout on Shevato to compare.' }, 403);
    let store, config;
    try { store = await storeFactory(); config = validateConfig(await store.get('config', { type: 'json' }) || {}, runtimeEnv); }
    catch { config = validateConfig({}, runtimeEnv); }
    const adapters = createAdapters(config, fetcher);
    if (req.method === 'GET') return json({ verticals: VERTICALS.map(v => ({ ...v, capability: store && adapters.some(a => a.vertical === v.id && a.enabled) ? 'Beta' : 'Requires provider integration' })), vehicleData: !!store });
    const requestId = randomUUID(); let request;
    try {
      if (!(req.headers.get('content-type') || '').startsWith('application/json')) return json({ message: 'Send JSON.' }, 415);
      request = validateRequest(await readJSON(req, 4096));
    } catch (e) { log({ event: 'quotescout_validation', requestId, status: 'INVALID_INPUT' }); return json({ message: ERRORS[e.code] || ERRORS.INVALID_INPUT, field: e.field || '', requestId }, 400); }
    // A random per-tab capability scopes private memory caches. Never persisted or logged.
    const session = req.headers.get('x-quotescout-session') || '';
    if (!/^[a-f0-9]{64}$/.test(session)) return json({ message: 'Reload QuoteScout and try again.' }, 400);
    if (!store) return json({ message: 'Comparisons are temporarily unavailable. Please try again later.', requestId }, 503);
    const ip = context.ip;
    if (!ip && env.QUOTESCOUT_ALLOW_LOCAL_PROVIDERS !== '1') return json({ message: 'Comparisons are temporarily unavailable.', requestId }, 503);
    const identity = ip || 'local';
    try { if (!await reserveQuota(store, identity, 'request')) return json({ message: ERRORS.RATE_LIMIT, requestId }, 429); }
    catch { return json({ message: 'Comparisons are temporarily unavailable.', requestId }, 503); }
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder(); let closed = false;
        const emit = e => { if (!closed) { try { controller.enqueue(encoder.encode(JSON.stringify(e) + '\n')); } catch { closed = true; } } };
        const configKey = hash(JSON.stringify(config));
        if (!engines.has(configKey)) {
          if (engines.size >= 2) engines.delete(engines.keys().next().value);
          engines.set(configKey, createEngine({ adapters, cache, enrichment, emitMetric: log }));
        }
        const engine = engines.get(configKey);
        engine(request, hash(session + configKey), emit, provider => reserveQuota(store, identity, provider).catch(() => false)).catch(() => emit({ type: 'error', message: 'Comparison could not finish. Please retry.' })).finally(() => { if (!closed) { try { controller.close(); } catch { /* disconnected */ } } });
      },
    });
    return new Response(stream, { headers: { ...HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
  };
}
export default createHandler();
export const config = { rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip'] } };
