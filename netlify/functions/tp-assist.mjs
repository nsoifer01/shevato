// Trip Planner site assistant (Tier 3): a rate-limited, shared-key proxy in
// front of Google's Gemini API so travellers can use the assistant without
// bringing their own key. The browser sends the trip context + chat history;
// this function builds the system instruction server-side, enforces per-client
// and global daily quotas, and never returns the key or upstream detail.
//
// OWNER SETUP (one-time, out-of-band; env vars are NOT injected into functions
// on this site, so the key lives in a Blob):
//   1. Get a free Gemini API key at https://aistudio.google.com/apikey
//   2. netlify blobs:set trip-planner-assist config '{"geminiKey":"<key>"}' --json
//   3. Disable again with: netlify blobs:set trip-planner-assist config '{}' --json
// With no key set the endpoint returns 503 not_configured and the UI falls back
// to Tier 1 / bring-your-own-key.

import { checkQuota } from './lib/tp-assist-quota.mjs';

// The Blob store pulls in @netlify/blobs (installed only in the Netlify build,
// gitignored locally). It is imported lazily below, after the origin/method/
// body guards, so those guards stay unit-testable without the dependency.

const GEMINI_MODEL = 'gemini-2.5-flash';
const MAX_MESSAGES = 40;
const MAX_CONTENT = 4000;
const MAX_TRIP_JSON = 30000;

// Pinned server-side system instruction. Mirrors the client's assistant
// contract (js/trip-logic.js) so the model emits the same tripActions JSON the
// browser knows how to parse into proposal cards.
const SYSTEM_PREAMBLE = [
  'You are a travel-planning assistant helping edit a trip itinerary.',
  'You cannot check live reviews, prices or availability. For anything you suggest, include a mapsQuery so the traveller can open Google Maps and verify hours, prices and reviews themselves.',
  'Each item has: type (one of flight, transport, activity, stay, note), title, location, startDate (YYYY-MM-DD), startTime (HH:MM, 24h), endDate (YYYY-MM-DD, the check-out date for a stay or the arrival date for an overnight leg), endTime (HH:MM), cost (a number), costCurrency (a 3-letter code like USD), details, and mapsQuery (a place to search on Google Maps so the traveller can verify hours, prices and reviews).',
  'When you want to add, change or remove items, include a JSON object in a ```json fenced block shaped exactly like {"tripActions":[{"op":"add","item":{...}},{"op":"update","match":{"title":"..."},"set":{...}},{"op":"remove","match":{"title":"..."}}]}. Use op "add" with a full item, "update" with a match (by id or exact title) and the fields to set, or "remove" with a match. Never set status to booked or cancelled. Write your normal explanation as plain prose around the JSON block.',
].join('\n\n');

export default async function handler(req) {
  // (1) Origin/Referer guard first: only our own site and local dev.
  if (!originAllowed(req)) return json({ error: 'origin_rejected' }, 403);

  // (2) POST only.
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  // (3) Parse + clamp the body.
  let body;
  try { body = await req.json(); }
  catch { return json({ error: 'bad_request' }, 400); }
  const clamped = clampBody(body);
  if (!clamped.ok) return json({ error: 'bad_request' }, 400);

  // (4) Shared key from the config blob; absent -> not configured.
  const { assistStore, CONFIG_KEY, USAGE_KEY } = await import('./lib/tp-assist-store.mjs');
  const store = assistStore();
  const cfg = (await store.get(CONFIG_KEY, { type: 'json' })) || {};
  const geminiKey = cfg.geminiKey;
  if (!geminiKey) return json({ error: 'not_configured' }, 503);

  // (5) Quota check against the usage blob; rejected calls never hit upstream.
  const now = Date.now();
  const usage = (await store.get(USAGE_KEY, { type: 'json' })) || {};
  const q = checkQuota(usage, clamped.clientId, now);
  if (!q.allowed) return json({ error: 'quota_exceeded', scope: q.scope }, 429);

  // Reserve the slot BEFORE the upstream call so a burst of parallel requests
  // can't overrun the limit; the minor cost is that a failed upstream still
  // counts against the quota.
  await store.setJSON(USAGE_KEY, q.usage);

  // (6) Build the system instruction server-side from the pinned constant plus
  // the client-supplied trip context (messages were already role-filtered).
  const sys = buildSystemInstruction(clamped.tripContext);
  const contents = clamped.messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // (7) Call Gemini.
  let reply;
  try {
    reply = await callGemini(geminiKey, sys, contents);
  } catch {
    return json({ error: 'upstream' }, 502);
  }

  // (8) Success.
  return json({ reply }, 200);
}

function originAllowed(req) {
  const src = req.headers.get('origin') || req.headers.get('referer') || '';
  if (!src) return false;
  try {
    const u = new URL(src);
    if (u.protocol === 'https:' && u.hostname === 'shevato.com') return true;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return false;
  } catch { return false; }
}

function clampBody(body) {
  if (!body || typeof body !== 'object') return { ok: false };
  const clientId = typeof body.clientId === 'string' ? body.clientId.slice(0, 100).trim() : '';
  if (!clientId) return { ok: false };

  const raw = Array.isArray(body.messages) ? body.messages : [];
  const messages = raw
    .filter(m => m && typeof m === 'object'
      && (m.role === 'user' || m.role === 'assistant' || m.role === 'model')
      && typeof m.content === 'string')
    .slice(-MAX_MESSAGES)
    .map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content.slice(0, MAX_CONTENT) }));
  if (!messages.length) return { ok: false };

  const tripContext = (body.tripContext && typeof body.tripContext === 'object') ? body.tripContext : {};
  if (JSON.stringify(tripContext).length > MAX_TRIP_JSON) return { ok: false };

  return { ok: true, clientId, messages, tripContext };
}

function buildSystemInstruction(ctx) {
  const parts = [SYSTEM_PREAMBLE];
  const today = typeof ctx.today === 'string' ? ctx.today.slice(0, 10) : '';
  const focus = typeof ctx.focusDate === 'string' ? ctx.focusDate.slice(0, 10) : '';
  if (today) parts.push('Today is ' + today + '.');
  if (focus) parts.push('The traveller is focused on this day: ' + focus + '.');
  if (ctx.trip && typeof ctx.trip === 'object') {
    parts.push('Here is the current trip as JSON:\n' + JSON.stringify(ctx.trip).slice(0, MAX_TRIP_JSON));
  }
  return parts.join('\n\n');
}

async function callGemini(key, sys, contents) {
  // header auth: AQ.-prefixed keys reject the legacy ?key= query param,
  // and this keeps the key out of URLs and request logs
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/'
    + GEMINI_MODEL + ':generateContent';
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
    body: JSON.stringify({
      systemInstruction: { parts: [{ text: sys }] },
      contents,
      generationConfig: { maxOutputTokens: 1000, temperature: 0.5 },
    }),
  });
  if (!res.ok) {
    // function logs only; body helps diagnose, key never logged
    const body = await res.text().catch(() => '');
    console.error('tp-assist gemini error', res.status, body.slice(0, 500));
    throw new Error('gemini ' + res.status);
  }
  const data = await res.json();
  const parts = (data && data.candidates && data.candidates[0]
    && data.candidates[0].content && data.candidates[0].content.parts) || [];
  return parts.map(p => (p && p.text) || '').join('');
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
