# QuoteScout engineering findings

- Provider availability is the product boundary: no keys/contracts are established by code. Keep unavailable verticals outside the active input selector. Vehicle decoding is useful public data, not a substitute for real quotes.
- EasyPost developer terms do not automatically permit a white-label comparison platform. The agreement flag and explicit carrier IDs are required in addition to a key. Rate-only `/beta/rates` avoids creating shipments; keep it labeled Beta and never expose a test-mode amount.
- An API account’s shipping rate is not purchasable on an arbitrary carrier website. No handoff is better than falsely suggesting the same rate can be bought there.
- CMS ZIPs can cross counties and state lines. Never pick the first county silently. The additional-question answer must be validated against the lookup result again.
- CMS uses `In-Network` and individual cost types. Multiple medical/drug or CSR rows cannot be collapsed to the minimum. Unknown costs sort last, not as zero. Annual premium is not expected annual cost.
- The no-subscription/no-lead UX does not remove insurance producer obligations. Auto/home stay disabled until an actual licensed-partner contract and legal review exist; no homemade state minimum limits.
- Private cache isolation includes per-tab capability, input, provider and config fingerprint. Config changes must not serve prices under the old account. Circuit and pending maps must outlive one request to be meaningful; engine instances are reused per config.
- Shared main.css overrides button colors and strong text. App-scoped pins and computed-style/axe checks are required, including the simple commitment copy.
- Existing app-order tests had three literal eight-app counts despite the manifest convention. They now derive counts from the manifest so adding QuoteScout preserves the invariant rather than merely changing a magic number.
- Static-only serving cannot run Netlify Functions. Its unavailable state is intentional; meaningful E2E flows intercept the function endpoint with fixtures isolated in the E2E suite. Do not change the app to fake results for localhost.
- Preview artwork is a screenshot of the empty vehicle form; fixture price images are not marketed as real offers.

- Use Netlify runtime `context.deploy.context` to distinguish production and previews; build-time `CONTEXT` is not a reliable runtime source. A regression test prevents a stale environment value from enabling paid calls in a preview.
- Duplicate detection must include the actual carrier/issuer and health plan identity. Different carriers can return the same service label and amount.

- Root publishing includes source directories, so forced 404 routes protect QuoteScout fixture paths. This is independent of the normal application import boundary and does not change other apps’ runtime assets.
