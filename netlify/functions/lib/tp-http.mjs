// Request guards shared by every tp-* function. These were copy-pasted into
// each function; a divergence here (say, one function forgetting the referer
// fallback) would be an inconsistency an attacker could probe for, so there is
// exactly one definition.

// Only our own site and local dev. The referer fallback matters: some browsers
// omit Origin on same-origin POSTs from older code paths, and a same-site
// request must not be rejected for it.
export function originAllowed(req) {
  const src = req.headers.get('origin') || req.headers.get('referer') || '';
  if (!src) return false;
  try {
    const u = new URL(src);
    if (u.protocol === 'https:' && u.hostname === 'shevato.com') return true;
    if (u.hostname === 'localhost' || u.hostname === '127.0.0.1') return true;
    return false;
  } catch { return false; }
}

export function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// Upstream calls get a deadline so a hung provider fails fast, and the value
// must sit UNDER Netlify's synchronous-function execution limit: past that the
// platform kills the invocation and the browser receives a gateway error page
// instead of our JSON, so the UI's specific fallback handling never runs.
// That platform limit is 60s (docs.netlify.com/build/functions/configuration,
// "Synchronous execution limit", verified 2026-08-16; an older 10s belief here
// sized this at 9s and broke every assistant turn longer than that).
// 9s stays the DEFAULT because tp-places makes two sequential lookups per
// request and its Places calls run well under a second; callers whose upstream
// legitimately works longer (tp-assist generating a full day plan) pass their
// own budget.
export const UPSTREAM_TIMEOUT_MS = 9000;
export function upstreamSignal(ms = UPSTREAM_TIMEOUT_MS) {
  return AbortSignal.timeout(ms);
}
