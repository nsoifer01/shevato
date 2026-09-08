import { updateUsage } from '../blob-cas.mjs';
import { hash } from './engine.mjs';
// Every priced source Quote Scout serves is a public dataset that travels with
// the function, so there is no provider credential left to validate. This stays
// as the single place a future credential would be admitted, and as the shape
// the engine cache key is computed from.
export function validateConfig() {
  return {};
}
export async function getStore() {
  const { getStore: open } = await import('@netlify/blobs');
  return open({ name: 'quotescout', consistency: 'strong' });
}
export async function reserveQuota(store, identity, provider, now = Date.now()) {
  // One rolling usage blob, bounded cardinality and CAS prevent cross-instance overspend.
  // Hashed identities expire with their hourly counters; no quote/request contents persist.
  const hour = Math.floor(now / 3600000), day = Math.floor(now / 86400000), month = new Date(now).toISOString().slice(0,7);
  const identityKey = hash(`${day}:${identity}`);
  const strictStore = { getWithMetadata: (...args) => store.getWithMetadata(...args), async setJSON(...args) { const r = await store.setJSON(...args); if (typeof r?.modified !== 'boolean') throw new Error('quota_store_unavailable'); return r; } };
  const outcome = await updateUsage(strictStore, 'usage', old => {
    const users = old.hour === hour && old.users && typeof old.users === 'object' ? { ...old.users } : {};
    const calls = old.day === day ? (old.calls || 0) : 0, monthly = old.month === month ? (old.monthly || 0) : 0;
    const perProvider = old.day === day ? { ...old.providers } : {};
    const count = users[identityKey] || 0;
    if (count >= 30 || calls >= 1000 || monthly >= 10000 || (perProvider[provider] || 0) >= (provider === 'easypost' ? 200 : 1000) || (!count && Object.keys(users).length >= 1000)) return { result: false };
    users[identityKey] = count + 1; perProvider[provider] = (perProvider[provider] || 0) + 1;
    return { write: { hour, day, month, users, calls: calls + 1, monthly: monthly + 1, providers: perProvider }, result: true };
  });
  return outcome.ok && outcome.result === true;
}
