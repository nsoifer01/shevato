import { ScoutError } from './validation.mjs';
export const ERRORS = {
  INVALID_INPUT: 'Check the highlighted information and try again.', UNSUPPORTED: 'This request is outside the supported locations or product limits.',
  UNAVAILABLE: 'This provider cannot return options right now.', TIMEOUT: 'This provider took too long. You can try again.', RATE_LIMIT: 'The comparison limit has been reached. Please try again later.',
  AUTH: 'This provider is temporarily unavailable.', MALFORMED: 'The provider returned information we could not verify.', ADDITIONAL: 'One more detail is needed for this provider.',
};
export async function readJSON(response, max = 1500000) {
  const reader = response.body?.getReader();
  if (!reader) throw new ScoutError('MALFORMED');
  const chunks = []; let size = 0;
  try {
    while (true) { const { done, value } = await reader.read(); if (done) break; size += value.length; if (size > max) throw new ScoutError('MALFORMED'); chunks.push(value); }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch { await reader.cancel().catch(() => {}); throw new ScoutError('MALFORMED'); }
}
export async function upstream(url, { fetcher = fetch, signal, method = 'GET', headers = {}, body, reserve = async () => true } = {}) {
  // URLs are constructed only inside adapters, never accepted from the browser/config.
  for (let attempt = 0; attempt < 2; attempt++) {
    if (!await reserve()) throw new ScoutError('RATE_LIMIT');
    let r;
    try { r = await fetcher(url, { method, headers, body: body ? JSON.stringify(body) : undefined, signal, redirect: 'error' }); }
    catch { throw new ScoutError(signal?.aborted ? 'TIMEOUT' : 'UNAVAILABLE'); }
    if (r.status === 429) { await r.body?.cancel(); throw new ScoutError('RATE_LIMIT'); }
    if ([401,403].includes(r.status)) { await r.body?.cancel(); throw new ScoutError('AUTH'); }
    if (r.status >= 500) { await r.body?.cancel(); if (!attempt && method === 'GET') continue; throw new ScoutError('UNAVAILABLE'); }
    if (!r.ok) { await r.body?.cancel(); throw new ScoutError(r.status === 404 ? 'UNSUPPORTED' : 'INVALID_INPUT'); }
    return readJSON(r);
  }
}
export function deadline(task, ms = 12000) {
  const controller = new AbortController(); let timer;
  const timeout = new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new ScoutError('TIMEOUT')); }, ms); });
  return Promise.race([Promise.resolve().then(() => task(controller.signal)), timeout]).finally(() => clearTimeout(timer));
}
