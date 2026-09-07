// CSP violation sink.
//
// The site shipped a Content-Security-Policy-Report-Only header with NO
// report destination, so a violation produced a console message in one
// visitor's browser and nothing else. That is not a feedback loop: three Trip
// Planner origins (photon.komoot.io, api.open-meteo.com,
// geocoding-api.open-meteo.com) were missing from connect-src for weeks, and
// the policy that was supposed to notice said nothing (2026-09-05 audit F14).
//
// WHAT IS RECORDED, and nothing else:
//   - which directive was violated ('script-src-elem')
//   - the ORIGIN of the blocked resource ('https://evil.example'), never its
//     path or query
//   - the PATH of the page it happened on, with the query and fragment
//     removed - a Trip Planner share fragment carries an itinerary, and a
//     search page's query carries what somebody typed
//   - whether the policy was enforcing or reporting
//
// Deliberately NOT recorded: script-sample (it is a slice of the offending
// SOURCE, which on this site can be app code handling user data), the
// referrer, the full document URL, any header, and the caller's address.
//
// Reports are logged, not stored. They go to the function log, which the
// owner reads; a blob store would turn an unauthenticated public endpoint
// into a write amplifier for anyone who noticed it.

import { json } from './lib/tp-http.mjs';

// A browser sends one small JSON body. Anything larger is not a CSP report.
const MAX_BODY_BYTES = 8192;

/** Origin only, or '' for the opaque keywords a report can carry. */
export function safeOrigin(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  // 'inline', 'eval', 'wasm-eval', 'data', 'blob' - already non-identifying.
  if (!raw.includes('://')) return raw.slice(0, 32);
  try { return new URL(raw).origin; } catch { return 'unparseable'; }
}

/** Path only: no query, no fragment, capped. */
export function safePath(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  try { return new URL(raw).pathname.slice(0, 200); } catch { return ''; }
}

/** The one line that reaches the log. Pure, so it is unit-testable. */
export function summarise(report) {
  const r = (report && typeof report === 'object') ? report : {};
  const body = r['csp-report'] && typeof r['csp-report'] === 'object' ? r['csp-report'] : r;
  const directive = String(body['effective-directive'] || body['violated-directive'] || 'unknown')
    .split(/\s/)[0].slice(0, 40);
  return {
    directive,
    blockedOrigin: safeOrigin(body['blocked-uri']),
    documentPath: safePath(body['document-uri']),
    disposition: body.disposition === 'enforce' ? 'enforce' : 'report',
  };
}

export default async function handler(req) {
  // No origin guard: a violation report is sent by the BROWSER as a result of
  // our own header, and a browser does not always attach an Origin to it.
  // There is nothing here worth guarding - the endpoint reads nothing, writes
  // nothing, and answers 204 whatever it is handed.
  if (req.method !== 'POST') return json({ error: 'method_not_allowed' }, 405);

  let report = null;
  try {
    const text = (await req.text()).slice(0, MAX_BODY_BYTES);
    report = JSON.parse(text);
  } catch {
    // A malformed body is not an error worth answering: browsers send several
    // shapes (application/csp-report, application/reports+json), and a sink
    // that 400s on one of them just produces retries.
    return new Response(null, { status: 204 });
  }

  const reports = Array.isArray(report) ? report.slice(0, 20) : [report];
  for (const one of reports) {
    const s = summarise(one && one.body ? one.body : one);
    if (!s.directive || s.directive === 'unknown') continue;
    console.log('csp-violation', JSON.stringify(s));
  }
  return new Response(null, { status: 204 });
}
