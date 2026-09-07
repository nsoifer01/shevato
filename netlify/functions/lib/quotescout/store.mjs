import { updateUsage } from '../blob-cas.mjs';
import { hash } from './engine.mjs';
export function validateConfig(raw = {}, env = {}) {
  const key = (v, max = 300) => typeof v === 'string' && v.length >= 10 && v.length <= max && !/\s/.test(v) ? v : undefined;
  const config = { cmsKey: key(env.QUOTESCOUT_CMS_KEY || raw.cmsKey), easypostKey: key(env.QUOTESCOUT_EASYPOST_KEY || raw.easypostKey), carrierAccounts: raw.carrierAccounts };
  if (raw.easypostPlatformApproved !== true) config.easypostKey = undefined;
  if (!Array.isArray(config.carrierAccounts) || !config.carrierAccounts.length || config.carrierAccounts.length > 10 || config.carrierAccounts.some(v => typeof v !== 'string' || !/^ca_[a-zA-Z0-9]+$/.test(v))) { config.easypostKey = undefined; config.carrierAccounts = undefined; }
  if (env.CONTEXT !== 'production' && env.QUOTESCOUT_ALLOW_LOCAL_PROVIDERS !== '1') { config.cmsKey = undefined; config.easypostKey = undefined; }
  return config;
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
