import { randomUUID } from 'node:crypto';
import { VERTICALS } from '../../apps/quotescout/js/model.js';
import { validateRequest } from './lib/quotescout/validation.mjs';
import { createAdapters } from './lib/quotescout/adapters.mjs';
import { createEngine, BoundedCache, hash } from './lib/quotescout/engine.mjs';
import { getStore, validateConfig, reserveQuota } from './lib/quotescout/store.mjs';
import { readJSON, ERRORS } from './lib/quotescout/http.mjs';
import { getMeta as marketplaceMeta } from './lib/quotescout/marketplace.mjs';
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
    // Same-deploy previews can exercise the free tool, while paid adapters
    // remain disabled by the runtime-context configuration gate.
    if (['deploy-preview', 'branch-deploy'].includes(context.deploy?.context)) {
      try { const url = new URL(req.url); originOK ||= url.protocol === 'https:' && url.hostname.endsWith('.netlify.app') && origin === url.origin; } catch { /* invalid URL */ }
    }
    if (local && env.QUOTESCOUT_ALLOW_LOCAL_PROVIDERS === '1') { try { const u = new URL(origin); originOK ||= ['localhost','127.0.0.1'].includes(u.hostname) && ['http:','https:'].includes(u.protocol); } catch { /* invalid */ } }
    if (req.method !== 'GET' && req.method !== 'POST') return json({ message: 'Method not allowed.' }, 405);
    if (req.method === 'POST' && !originOK) return json({ message: 'Open Quote Scout on Shevato to compare.' }, 403);
    let store, config;
    try { store = await storeFactory(); config = validateConfig(await store.get('config', { type: 'json' }) || {}, runtimeEnv); }
    catch { config = validateConfig({}, runtimeEnv); }
    const adapters = createAdapters(config, fetcher);
    // Adapters that call an upstream API cost money or third-party quota, so
    // they only run when the usage store is available to meter them. Marking
    // them disabled rather than dropping them keeps the honest per-provider
    // "unavailable" line in the results. The marketplace dataset ships inside
    // this function and calls nothing, so it stays available without Blobs.
    const runtime = adapters.map(a => (a.external && !store ? { ...a, enabled: false } : { ...a }));
    const usable = a => a.enabled;
    if (req.method === 'GET') {
      const verticals = VERTICALS.map(v => {
        const live = runtime.filter(a => a.vertical === v.id && usable(a));
        return {
          ...v,
          capability: live.length ? (live.some(a => a.capability === 'Public data') ? 'Public data' : 'Beta') : 'Requires provider integration',
          // The same identities the streaming start event already reports, so
          // the page can name its sources before anyone submits anything.
          sources: live.map(a => ({ id: a.id, name: a.name, capability: a.capability })),
        };
      });
      const meta = marketplaceMeta();
      return json({
        verticals,
        vehicleData: runtime.some(a => a.vertical === 'vehicle-data' && usable(a)),
        planYear: meta.planYear,
        states: meta.states,
        dataPublishedAt: meta.pufImportDate,
        // Medicare covers every state and territory, and a different plan year
        // stamp, so the page cannot infer its coverage from the marketplace's.
        medicare: meta.medicare ? { year: meta.planYear, states: meta.medicare.states, publishedAt: meta.medicare.publishedAt } : null,
      });
    }
    const requestId = randomUUID(); let request;
    try {
      if (!(req.headers.get('content-type') || '').startsWith('application/json')) return json({ message: 'Send JSON.' }, 415);
      request = validateRequest(await readJSON(req, 4096));
    } catch (e) { log({ event: 'quotescout_validation', requestId, status: 'INVALID_INPUT' }); return json({ message: ERRORS[e.code] || ERRORS.INVALID_INPUT, field: e.field || '', requestId }, 400); }
    // A random per-tab capability scopes private memory caches. Never persisted or logged.
    const session = req.headers.get('x-quotescout-session') || '';
    if (!/^[a-f0-9]{64}$/.test(session)) return json({ message: 'Reload Quote Scout and try again.' }, 400);
    // Only a request that can actually reach a paid or third-party API needs
    // metering; a comparison served entirely from the bundled dataset does not.
    const metered = runtime.some(a => a.vertical === request.vertical && a.enabled && a.external);
    const ip = context.ip;
    // Without an identity we cannot meter anyone, so a request that can reach a
    // paid API is refused outright. A comparison served from the bundled
    // dataset spends nobody's money and is still bounded by the platform rate
    // limit declared at the bottom of this file.
    if (metered && !ip && env.QUOTESCOUT_ALLOW_LOCAL_PROVIDERS !== '1') return json({ message: 'Comparisons are temporarily unavailable.', requestId }, 503);
    const identity = ip || 'local';
    if (store) {
      // Every comparison counts against the ceiling when we can record it; only
      // one that could spend money fails closed when the store is unreachable.
      try { if (!await reserveQuota(store, identity, 'request')) return json({ message: ERRORS.RATE_LIMIT, requestId }, 429); }
      catch { if (metered) return json({ message: 'Comparisons are temporarily unavailable.', requestId }, 503); }
    }
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder(); let closed = false;
        const emit = e => { if (!closed) { try { controller.enqueue(encoder.encode(JSON.stringify(e) + '\n')); } catch { closed = true; } } };
        // Store availability changes which adapters an engine holds, so it is
        // part of the engine's identity alongside the provider configuration.
        const configKey = hash(JSON.stringify(config) + (store ? ':metered' : ':unmetered'));
        if (!engines.has(configKey)) {
          if (engines.size >= 2) engines.delete(engines.keys().next().value);
          engines.set(configKey, createEngine({ adapters: runtime, cache, enrichment, emitMetric: log }));
        }
        const engine = engines.get(configKey);
        engine(request, hash(session + configKey), emit, provider => (store ? reserveQuota(store, identity, provider).catch(() => false) : Promise.resolve(true))).catch(() => emit({ type: 'error', message: 'Comparison could not finish. Please retry.' })).finally(() => { if (!closed) { try { controller.close(); } catch { /* disconnected */ } } });
      },
    });
    return new Response(stream, { headers: { ...HEADERS, 'Content-Type': 'application/x-ndjson; charset=utf-8' } });
  };
}
export default createHandler();
export const config = { rateLimit: { windowLimit: 40, windowSize: 60, aggregateBy: ['ip'] } };
