import { createHash, randomUUID } from 'node:crypto';
import { deadline, ERRORS } from './http.mjs';
import { ScoutError } from './validation.mjs';
import { PRICED, CONTINUE_URLS } from '../../../../apps/quotescout/js/model.js';
export const hash = value => createHash('sha256').update(value).digest('hex');
export class BoundedCache {
  constructor(max = 250, now = Date.now) { this.entries = new Map(); this.max = max; this.now = now; }
  get(key) { const v = this.entries.get(key); if (!v) return null; if (v.until <= this.now()) { clearTimeout(v.timer); this.entries.delete(key); return null; } return structuredClone(v.data); }
  set(key, data, ttl) {
    if (this.entries.has(key)) clearTimeout(this.entries.get(key).timer);
    if (this.entries.size >= this.max) { const oldest = this.entries.keys().next().value; clearTimeout(this.entries.get(oldest).timer); this.entries.delete(oldest); }
    const entry = { data: structuredClone(data), until: this.now() + ttl };
    this.entries.set(key, entry);
    entry.timer = setTimeout(() => { if (this.entries.get(key) === entry) this.entries.delete(key); }, ttl);
    entry.timer.unref?.();
  }
}
export function createEngine({ adapters, reserve = async () => true, emitMetric = () => {}, now = Date.now, timeout = 12000, concurrency = 3, cache = new BoundedCache(250, now), enrichment = new BoundedCache(500, now) }) {
  const pending = new Map(), enrichmentPending = new Map(), circuits = new Map();
  async function enrich(key, ttl, fetchValue) {
    const k = hash(key), hit = enrichment.get(k);
    if (hit) return hit;
    if (enrichmentPending.has(k)) return enrichmentPending.get(k);
    const p = Promise.resolve().then(fetchValue).then(data => { enrichment.set(k, data, ttl); return data; }).finally(() => enrichmentPending.delete(k));
    enrichmentPending.set(k, p); return p;
  }
  return async function compare(request, scope, emit = () => {}, reserveCall = reserve) {
    const requestId = randomUUID(), all = [], seen = new Set();
    const selected = adapters.filter(a => a.vertical === request.vertical && (!request.provider || a.id === request.provider));
    emit({ type: 'start', requestId, providers: selected.map(a => ({ id: a.id, name: a.name, enabled: a.enabled })) });
    let cursor = 0;
    async function runProvider(a) {
      const started = now(), key = hash(JSON.stringify([scope, request.vertical, request.input, a.id]));
      let result, cached = false;
      try {
        if (!a.enabled) throw new ScoutError('UNAVAILABLE');
        const hit = !request.refresh && cache.get(key);
        if (hit) { result = hit; cached = true; }
        else {
          if ((circuits.get(a.id)?.until || 0) > now()) throw new ScoutError('UNAVAILABLE');
          if (!pending.has(key)) {
            const task = deadline(signal => a.quote(request.input, { signal, enrich, reserve: () => reserveCall(a.id) }), timeout)
              .then(value => {
                if (!value || !Array.isArray(value.quotes) || value.quotes.length > 500) throw new ScoutError('MALFORMED');
                const normalized = { ...value, quotes: value.quotes.map(q => verify(q, a, request, now())) };
                if (!normalized.questions && !normalized.rejected && !normalized.warning) cache.set(key, normalized, a.ttl);
                circuits.delete(a.id); return normalized;
              }).finally(() => pending.delete(key));
            pending.set(key, task);
          }
          result = await pending.get(key);
        }
        result = { ...result, quotes: result.quotes.map(q => ({ ...q, status: Date.parse(q.expiresAt) <= now() ? 'EXPIRED' : q.status })) };
        const unique = result.quotes.filter(q => { const k = JSON.stringify([q.provider, q.providerName, q.name, q.amount, q.currency, q.comparisonKey, q.vertical === 'health-insurance' ? q.provenance.sourceId : null]); if (seen.has(k)) return false; seen.add(k); return true; });
        result = { ...result, quotes: unique };
        result.status = result.questions?.length ? 'ADDITIONAL' : result.quotes.length || result.vehicle ? 'OK' : result.rejected ? 'MALFORMED' : 'UNAVAILABLE';
      } catch (e) {
        const code = Object.hasOwn(ERRORS, e?.code) ? e.code : 'UNAVAILABLE';
        if (['TIMEOUT','UNAVAILABLE','AUTH','MALFORMED'].includes(code)) {
          const count = (circuits.get(a.id)?.count || 0) + 1;
          circuits.set(a.id, { count, until: count >= 3 ? now() + 60000 : 0 });
        }
        result = { status: code, quotes: [], message: ERRORS[code] };
      }
      const event = { type: 'provider', provider: a.id, name: a.name, enabled: !!a.enabled, ...result, cached };
      all.push(event); emit(event);
      // Allowlisted dimensions only. Never pass request, upstream bodies or Error objects.
      emitMetric({ event: 'quotescout_provider', requestId, vertical: request.vertical, provider: a.id, configured: a.enabled, status: result.status, latencyMs: now() - started, quoteYield: result.quotes.length, estimates: result.quotes.filter(q => q.status === 'ESTIMATE').length, verified: result.quotes.filter(q => q.status === 'VERIFIED QUOTE').length, published: result.quotes.filter(q => q.status === 'AUTHORITATIVE PUBLIC RATE').length, cacheHit: cached, additionalQuestions: result.questions?.length || 0 });
    }
    // Unique adapter registration; duplicated IDs are a programming error, never extra queries.
    const unique = selected.filter((a, i) => selected.findIndex(b => b.id === a.id) === i);
    await Promise.all(Array.from({ length: Math.min(concurrency, unique.length) }, async () => { while (cursor < unique.length) await runProvider(unique[cursor++]); }));
    const final = { type: 'done', requestId, checked: all.filter(p => !['UNAVAILABLE'].includes(p.status) || selected.find(a => a.id === p.provider)?.enabled).length, returned: all.reduce((n,p) => n+p.quotes.length,0), unavailable: all.filter(p => !['OK','ADDITIONAL'].includes(p.status) && p.enabled).length, additional: all.filter(p => p.status === 'ADDITIONAL').length };
    emitMetric({ event: 'quotescout_request', requestId, vertical: request.vertical, checked: final.checked, quoteYield: final.returned, unavailable: final.unavailable, additionalQuestions: final.additional });
    emit(final); return { providers: all, summary: final };
  };
}
function verify(q, adapter, request, now) {
  if (!q || !PRICED.includes(q.status) || q.provider !== adapter.id || q.vertical !== request.vertical || !Number.isSafeInteger(q.amount) || q.amount < 0 || !/^[A-Z]{3}$/.test(q.currency) || !q.id || !q.name || !q.comparisonKey || !q.provenance?.source || !q.provenance?.product || typeof q.provenance.checkoutExact !== 'boolean' || !q.provenance.warning || !Number.isFinite(Date.parse(q.retrievedAt)) || Date.parse(q.retrievedAt) > now + 1000 || !Number.isFinite(Date.parse(q.expiresAt)) || Date.parse(q.expiresAt) <= Date.parse(q.retrievedAt) || Date.parse(q.expiresAt) - Date.parse(q.retrievedAt) > adapter.ttl) throw new ScoutError('MALFORMED');
  if (q.status === 'VERIFIED QUOTE' && (q.provenance.kind !== 'live-quote' || !q.provenance.sourceId)) throw new ScoutError('MALFORMED');
  // A published rate must name the dataset it came from and the year it applies
  // to, because that pair is the whole of its freshness claim.
  if (q.status === 'AUTHORITATIVE PUBLIC RATE' && (q.provenance.kind !== 'published-rate' || !q.provenance.sourceId || !Number.isInteger(q.provenance.planYear) || !/^\d{4}-\d{2}-\d{2}$/.test(q.provenance.dataPublishedAt || ''))) throw new ScoutError('MALFORMED');
  if (q.provenance.kind === 'published-rate' && q.status !== 'AUTHORITATIVE PUBLIC RATE') throw new ScoutError('MALFORMED');
  if (q.continueUrl && !CONTINUE_URLS.includes(q.continueUrl)) throw new ScoutError('MALFORMED');
  // Complete request is retained only inside this user's short-lived memory cache.
  return { ...q, provenance: { ...q.provenance, requestParameters: request.input } };
}
