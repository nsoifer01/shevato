# QuoteScout threat model

Trust boundaries: browser → Netlify request handler → server-only Blobs configuration and budgets → fixed upstream APIs. Third-party responses are untrusted. Browser entry fields are PII-adjacent even when no contact fields exist.

| Threat | Implemented control | Remaining operational boundary |
| --- | --- | --- |
| Browser credential disclosure | Provider keys only in server config/environment; adapters return selected normalized fields; tests assert secrets absent | Hosting/Blob administrator access must remain restricted |
| SSRF/injection | Fixed HTTPS host/path construction, strict schemas, VIN/ZIP patterns, no redirects; provider strings rendered as text | A new adapter must keep this contract |
| Denial of wallet / parallel abuse | Edge limit plus strong-consistency CAS total/month/provider/IP reservations, counted retries; failure closes access | Calls are bounded, not contract dollars; billing alerts/account ceilings needed |
| Cross-user quote leakage | Random 256-bit in-memory tab capability, full-input/config/provider cache scope, no-store response headers, no durable quote database | The tab capability is a bearer secret; do not place it in logs or URLs |
| PII logs / analytics | Allowlisted metric objects only; no request/error-body logging; no quote/form analytics | Hosting/provider access logs are outside application-log controls; policy discloses hosting processing |
| Private cache retention | Bounded process caches, retrieval-preserving TTL, expiry timers; no browser persistence or service worker | Process suspension/cold starts are hosting-managed; expired entries are never served |
| Redirect / affiliate spoofing | Only fixed HealthCare.gov handoff accepted; noreferrer; no affiliate fields used for scoring | Future purchasable offers need explicit trusted destinations and contract validation |
| Malformed / fabricated prices | Decimal cents parsing, production-mode checks, currencies, provenance/product/timestamp verification | Provider truth itself depends on the provider; current estimates never become guaranteed prices |
| Coverage mismatch | Product grouping, dimensions, unknown values not zero, visible network/insurance warnings | No claim that metal level or service class makes every benefit equivalent |
| Slow/malformed upstream | 12s deadlines even if adapter ignores abort; bounded response bytes/rows, at most 3 adapters, safe GET retry only | Circuit breakers/deduplication are local; distributed quota is the durable guard |
| Forged county / normalized inputs | County must belong to provider-returned ZIP/year set; no browser-submitted state/vehicle object | Enrichment source correctness is authoritative source responsibility |
| Preview accidentally spends | Paid adapters disabled outside production unless explicit local opt-in; no fallback public CMS key | Do not enable opt-in for untrusted preview branches |

Origin checks are a browser misuse barrier, not authentication. IP must come from Netlify context, not a caller-supplied forwarding header. IP counters are daily-hashed and hourly-scoped; random session IDs do not bypass IP/global quota. Quote contents are never written into Blobs. NHTSA enrichment cache can contain its VIN-bearing response, documented in privacy.

Ordinary CI uses deterministic fixtures. Public API/sandbox checks are separate. Test prices live only in test/e2e directories. UI uses no innerHTML for provider data and has associated labels, error announcements and expiry handling. No API call purchases, binds, enrolls or contacts a sales agent.
