// Trip Planner site assistant (Tier 3): a rate-limited, shared-key proxy in
// front of Google's Gemini API so travellers can use the assistant without
// bringing their own key. The browser sends the trip context + chat history;
// this function builds the system instruction server-side, enforces per-client
// and global daily quotas, and never returns the key or upstream detail.
//
// OWNER SETUP (one-time, out-of-band; env vars are NOT injected into functions
// on this site, so the key lives in a Blob):
//   1. Get a free Gemini API key at https://aistudio.google.com/apikey
//   2. netlify blobs:set trip-planner-assist config '{"geminiKey":"<key>"}'
//   3. Disable again with: netlify blobs:set trip-planner-assist config '{}'
// With no key set the endpoint returns 503 not_configured and the UI falls back
// to Tier 1 / bring-your-own-key.
//
// The CLI must be linked to the site that actually serves shevato.com before
// running those commands; the blob store is per-site, so writing it while
// linked to any other project leaves this endpoint on 503.

import { checkQuota } from './lib/tp-assist-quota.mjs';
// SINGLE SOURCE OF TRUTH for the assistant contract. This used to be a
// hand-copied SYSTEM_PREAMBLE, which meant Tier 3 silently kept the old shape
// every time the client contract changed. trip-logic.js is a classic script
// that also sets module.exports, so Node's CJS interop gives us the namespace
// here and esbuild inlines it into the function bundle at build time.
import TripLogic from '../../apps/trip-planner/js/trip-logic.js';

// The Blob store pulls in @netlify/blobs (installed only in the Netlify build,
// gitignored locally). It is imported lazily below, after the origin/method/
// body guards, so those guards stay unit-testable without the dependency.

// Google retires older models for NEW api keys while still listing them in
// ListModels, so a stale pin fails only at generateContent time, as a 404 that
// surfaces here as a generic 502 upstream. gemini-2.5-flash reached that state
// ("no longer available to new users"); verify any replacement pin with a
// freshly created key before shipping it.
//
// Pinned to flash-lite on cost: measured 2026-07-19 against the real system
// contract, every candidate held the tripActions format (add / update / remove
// / a 9-item multi-day plan, all passing validateTripAction, and all correctly
// refusing a "mark it confirmed" request), so the only difference was price:
//   gemini-3.1-flash-lite    $0.0005-0.0029 per turn   <- this
//   gemini-3-flash-preview   $0.0019-0.0076 per turn   (also 503'd 3 of 4
//                                                       calls; preview models
//                                                       carry no availability
//                                                       guarantee - avoid)
//   gemini-3.5-flash         $0.0132 per turn
// If answer quality ever slips, gemini-3.5-flash is the known-good step up.
const GEMINI_MODEL = 'gemini-3.1-flash-lite';

// Gemini 3.x charges its internal reasoning to maxOutputTokens. At the old cap
// of 1000 a normal "suggest dinner and a bar" turn spent ~960 tokens thinking
// and returned 37 tokens of prose, cut off before the ```json block that
// becomes the proposal cards: the traveller saw a half-sentence and lost half
// the suggestions. Measured against the live model on 2026-07-19:
//   1000, default thinking -> MAX_TOKENS, 37 output tokens, no json block
//   4000, default thinking -> STOP, 1554 thinking, 589 output
//   4000, thinkingLevel low -> STOP,  799 thinking, 512 output
// thinkingLevel 'low' keeps the answers complete while roughly halving the
// billed reasoning.
//
// Raised to 12000 for the "plan my day" contract, which asks for far more per
// turn than that measurement: one action per agenda entry, PLUS 2-3 alternative
// candidates for every meal and drinks slot. A full day is ~3 activities +
// 3 meals x 3 candidates + 2 drinks x 3 candidates + a return-to-hotel leg,
// so ~19 add actions. Each action serializes to roughly 70-90 tokens (title,
// location, both dates and times, cost, currency, details, mapsQuery, group),
// i.e. 1300-1700 tokens of JSON, plus ~400-600 of prose around it, on top of
// ~800-1500 of reasoning over a longer system instruction. That lands at
// 2500-3800 in the good case and blows straight through 4000 on a busy day,
// which fails in the worst possible way: MAX_TOKENS truncates the tail, and
// the tail is the tripActions block. Output tokens are billed on what is
// actually produced, not on the cap, so the headroom is free unless used;
// 12000 is ~3x the expected worst case and still bounds a runaway loop.
const GENERATION_CONFIG = {
  maxOutputTokens: 12000,
  temperature: 0.5,
  thinkingConfig: { thinkingLevel: 'low' },
};

// A truncated reply is worse than a short one here: the fenced tripActions JSON
// lands at the END of the answer, so losing the tail silently drops the
// proposal cards. Surface it as prose the traveller can act on instead.
const TRUNCATION_NOTE = '\n\n_(This answer was cut short. Ask me to continue, or for fewer suggestions at a time.)_';

// Exported for the unit tests: joins the text parts and reports whether the
// model stopped naturally. Gemini returns thought-signature parts with no
// text, so the join has to tolerate part objects that carry no `text`.
export function readCandidate(data) {
  const cand = (data && data.candidates && data.candidates[0]) || {};
  const parts = (cand.content && cand.content.parts) || [];
  const text = parts.map(p => (p && p.text) || '').join('');
  const truncated = cand.finishReason === 'MAX_TOKENS';
  return { text: truncated && text ? text + TRUNCATION_NOTE : text, truncated };
}

export { GENERATION_CONFIG };
const MAX_MESSAGES = 40;
const MAX_CONTENT = 4000;
const MAX_TRIP_JSON = 30000;

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
  // A trip too big to send even after trimming gets its own answer: the UI can
  // then tell the traveller what happened and what to do, instead of showing
  // the generic failure a bare 400 produced.
  if (clamped.tooLarge) return json({ error: 'trip_too_large' }, 413);
  if (!clamped.ok) return json({ error: 'bad_request' }, 400);

  // (4) Shared key from the config blob; absent -> not configured.
  const { assistStore, CONFIG_KEY, USAGE_KEY } = await import('./lib/tp-assist-store.mjs');
  const store = assistStore();
  const cfg = (await store.get(CONFIG_KEY, { type: 'json' })) || {};
  // LOCAL DEVELOPMENT AFFORDANCE, not the production path: `netlify dev` serves
  // functions against a LOCAL blob store, which is empty, so Tier 3 would 503
  // on localhost even when the deployed site is configured. Deployed functions
  // on this site get no env vars injected (verified), so this fallback is inert
  // in production and the blob remains the only way the key is ever set there.
  const geminiKey = cfg.geminiKey || process.env.TP_GEMINI_KEY;
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
  const sys = buildSystemInstruction(clamped.tripContext, clamped.truncated);
  const contents = clamped.messages.map(m => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: [{ text: m.content }],
  }));

  // (7) Call Gemini.
  let reply;
  try {
    reply = await callGemini(geminiKey, sys, contents);
  } catch (err) {
    if (err && err.rateLimited) return json({ error: 'quota_exceeded', scope: 'upstream' }, 429);
    return json({ error: 'upstream' }, 502);
  }

  // (8) An empty reply (safety block, or a turn that spent its whole budget
  // thinking) would render as a blank chat bubble. Treat it as an upstream
  // failure so the UI shows its "try again, or use Tier 1" message instead.
  if (!reply.trim()) return json({ error: 'upstream' }, 502);

  // (9) Success.
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
  // A heavy trip is TRIMMED to fit, not rejected. This used to be a hard
  // `return { ok: false }`, i.e. a bare 400 with no explanation for a traveller
  // whose only mistake was writing long descriptions on ~40 items.
  // fitAssistContext drops free-text `details` first and never touches the
  // structural facts; `truncated` then has to reach the system instruction, or
  // the model reasons about a shortened trip as if it were complete.
  const fit = TripLogic.fitAssistContext(tripContext, MAX_TRIP_JSON);
  // 'untrimmable' is an oversize body with no trip in it: malformed, answered
  // as it always was. Only a REAL trip that still does not fit earns the
  // dedicated answer.
  if (!fit.ok) return { ok: false, tooLarge: fit.reason === 'still_too_big' };

  return { ok: true, clientId, messages, tripContext: fit.ctx, truncated: fit.truncated };
}

// Exported for the unit tests: the whole instruction comes from the shared
// client builder, so there is exactly one definition of the contract. The trip
// itself is already size-bounded by clampBody, which TRIMS an oversize trip and
// reports whether it had to; `truncated` carries that into the prompt so the
// model is told its view of the trip is incomplete.
export function buildSystemInstruction(ctx, truncated) {
  return TripLogic.buildAssistSystemPrompt({
    trip: (ctx.trip && typeof ctx.trip === 'object') ? ctx.trip : null,
    focusDate: typeof ctx.focusDate === 'string' ? ctx.focusDate.slice(0, 10) : '',
    today: typeof ctx.today === 'string' ? ctx.today.slice(0, 10) : '',
    truncated: !!truncated,
  });
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
      generationConfig: GENERATION_CONFIG,
    }),
  });
  if (!res.ok) {
    // function logs only; body helps diagnose, key never logged
    const body = await res.text().catch(() => '');
    console.error('tp-assist gemini error', res.status, body.slice(0, 500));
    const err = new Error('gemini ' + res.status);
    // Google's free tier caps requests per minute as well as per day, so a
    // busy minute is a capacity problem, not a broken assistant. Flagged here
    // so the handler can answer 429 and the UI can say "at capacity" rather
    // than "could not answer right now".
    err.rateLimited = res.status === 429;
    throw err;
  }
  const data = await res.json();
  const out = readCandidate(data);
  if (out.truncated) {
    // Worth a log line: a recurring MAX_TOKENS means GENERATION_CONFIG needs
    // raising again, and the traveller only sees a half-written suggestion.
    console.error('tp-assist gemini truncated', JSON.stringify(data.usageMetadata || {}));
  }
  return out.text;
}

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}
