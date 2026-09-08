# Quote Scout

Compare prices without the spam. A static Shevato frontend with a server-side comparison engine in Netlify Functions. It never creates synthetic production prices, collects leads, sells personal information, buys labels, binds insurance or enrolls health plans.

## Current capabilities

| Vertical | What it returns | Coverage |
| --- | --- | --- |
| **Health insurance** | Published CMS Marketplace premiums, deductibles and out-of-pocket maximums for every on-exchange individual medical plan, priced by ZIP, county, age and tobacco status | 30 HealthCare.gov states, ages 18-64, one adult, full premium before tax credits |
| **Dental insurance** | Published CMS Marketplace premiums for on-exchange individual dental plans | Same as health |
| **Medicare Advantage** | Published CMS landscape premiums, Part D deductible, in-network maximum out-of-pocket and CMS star rating for every non-special-needs Advantage plan sold in the county | All 50 states, DC and the territories. Part B premium not included |
| **Medicare Part D** | Published CMS landscape premiums, deductibles and star ratings for standalone drug plans in the shopper's PDP region | Same as Advantage |
| Vehicle data | NHTSA vPIC VIN validation and decoding. Specifications, never a price | North America plus decodable imports; metered behind the usage store |

Every one of these works with no credential, no partner and no outbound request: the datasets ship inside the function. Nothing is listed that does not work, so there are no unavailable categories, no reasons to explain and no dead buttons.

The API returns capability states. Only connected tools appear in the form, comparisons first and the vehicle decoder last, so the page opens on something that returns a price. Disabled categories appear in a disclosure with the reason and collect no personal information. Unsupported vertical schemas are platform extension points, not implemented quote integrations. Insurance coverage presets are not translated into legally sufficient state limits without a licensed partner’s versioned rules; no fabricated state-minimum table is included.

Eligibility is enforced where the rule is unambiguous and public: catastrophic plans are the cheapest medical plans in the file and are only sold to people under 30 or holding a hardship exemption, so they are withheld from anyone 30 or over and the omission is stated in the results rather than silently applied.

Categories that could not be delivered honestly were removed rather than left as disabled cards. Auto and home insurance need an insurance producer licence and a carrier contract; vehicle shipping, service contracts, internet and energy need commercial agreements or address-level data that has no public source; package shipping needs a paid carrier account and a platform agreement. What each would take, and what was researched and rejected, is recorded in [PROVIDERS.md](PROVIDERS.md).

## The datasets

`scripts/build-quotescout-data.mjs` builds `netlify/functions/lib/quotescout/data/` from six public, key-free government sources:

| Source | Supplies |
| --- | --- |
| [CMS Exchange Rate PUF](https://www.cms.gov/marketplace/resources/data/public-use-files) | The premium each insurer filed per plan, rating area, age and tobacco status |
| CMS Exchange Plan Attributes PUF | Issuer, plan name, metal level, plan type, deductible, MOOP, HSA eligibility, network tiers |
| CMS Exchange Service Area PUF | Which counties, and which ZIPs of a partial county, each plan is sold in |
| [CCIIO geographic rating areas](https://www.cms.gov/cciio/programs-and-initiatives/health-insurance-market-reforms/state-gra) | County (or 3-digit ZIP) to rating area, per state |
| [Census 2020 ZCTA/county relationship file](https://www2.census.gov/geo/docs/maps-data/data/rel2020/zcta520/tab20_zcta520_county20_natl.txt) | ZIP to county, so a shopper types only a ZIP |
| [CMS Medicare Advantage and Part D landscape file](https://www.cms.gov/medicare/coverage/prescription-drug-coverage) | Medicare premiums, deductibles, out-of-pocket limits and star ratings by county |

Output is one gzipped shard per state plus `zips`, `zip-states`, `counties` and a plain `meta.json`, about 3.8 MB in total and committed. Committing the derived data rather than downloading 300 MB of CSV during every deploy keeps builds fast and deterministic, and means a CMS outage cannot break a deploy or a comparison. `netlify.toml` ships the directory with the function through `included_files`; shards are gunzipped lazily, at most four states held at once. The runtime looks for the dataset in several places and keeps the one holding `meta.json`, because esbuild inlines `marketplace.mjs` into the function root and `import.meta.url` then points somewhere the data is not.

Premiums are stored as integer cents, delta-encoded in base 36 across ages 18-64, and decode back to the exact filed cent. `quotescout-marketplace.test.mjs` asserts the round trip, and the build itself was verified against the raw Rate PUF across all 30 states, six ages and both tobacco settings with no mismatches.

Regenerate for a new plan year with `npm run build:quotescout:data -- --year 2027`. Downloads are cached in `.quotescout-build-cache/` (gitignored). The build fails rather than emitting a partial dataset if a county cannot be resolved to a rating area, if the Rate PUF columns change, or if a CCIIO table stops parsing. The CCIIO tables contain long-standing transcription errors (`Kosclusko`, `Dubols`, `Chautaugua`, `Vermillion`, `Trail`, `Deleware`); the builder folds confusable characters and then allows a single-letter edit, requiring a unique match either way.

The Medicare shards are separate and tiny (about 120 KB for the whole country) because Medicare premiums do not vary with age, sex or tobacco: a plan costs what it costs in the county it is sold in. Special-needs plans are dropped at build time, since they are restricted to people who qualify by dual eligibility, institutional status or a named chronic condition. County names come from CMS as plain text, so `countyKey` folds diacritics as well as suffixes, which is what makes Puerto Rico's municipios and New Mexico's Dona Ana join at all.

**Marketplace coverage is exactly what the PUF covers, and Medicare's is not.** The Exchange PUFs carry the states whose marketplace runs on HealthCare.gov, currently 30. States with their own exchange (California, New York and others) are absent, and the app says so by name rather than returning an empty result. `meta.json` is the single source of truth for both state lists, the plan year and both publication dates, and the landing copy is generated from it. Medicare covers all 50 states, DC and the territories, so the ZIP index is nationwide and the marketplace adapter checks state coverage itself.

## Architecture

`input → strict validation → authoritative enrichment → eligibility / questions → bounded orchestration → adapter normalization → provenance verification → product grouping → ranking → Top 3`

- `js/model.js`: vertical registry, quote vocabulary, currency formatting and deterministic ranking. Shared browser/server module; no secrets.
- `js/app.js`: one-screen input, streaming NDJSON consumer, per-provider county continuation, results and expiry. All third-party strings use `textContent`.
- `netlify/functions/quotescout.mjs`: method/origin/body guards, capabilities, per-tab cache scoping, quota reservations, streamed results.
- `lib/quotescout/validation.mjs`: strict key allowlists, numeric limits, VIN normalization/check digit, ZIP/date validation. Browser-derived fields are never trusted.
- `adapters.mjs`: fixed HTTPS endpoints and minimal provider payloads. CMS county responses are validated again when a county is submitted.
- `http.mjs`: bounded JSON reads, no redirects, normalized errors, cancellation and deadlines. Only safe GETs retry once after a 5xx; every attempt reserves quota. POSTs and 429s do not automatically retry.
- `engine.mjs`: at most three concurrent adapters per comparison, a 12-second provider budget including enrichment, in-process deduplication, circuit breaker after three transient failures (60 seconds), bounded caches and event metrics.
- `marketplace.mjs`: lazy, LRU-bounded access to the committed CMS dataset. Resolves a ZIP to its counties, a county to its rating area, and a rating area to every plan sold there at the shopper's exact age; also computes the second-lowest-cost silver benchmark from the same rates. Decodes premiums only; it never adjusts one.
- `store.mjs`: server configuration and strong-consistency Netlify Blob compare-and-swap call budgets. Store failure or unsupported conditional writes fail closed.

NDJSON events are `start`, `provider`, `done` and, for an unexpected stream failure, `error`. Finished providers appear independently. No invented progress percentage or carrier count is displayed. A data-source count means API adapters, not the number of insurers behind one API. Carrier-level partial errors and excluded malformed rows stay visible.

## Quote contract and verification

A normalized quote has an adapter ID, source ID, display provider, vertical, currency, integer-cent price, interval, retrieval/expiry timestamps, comparison group, relevant details and provenance. Provenance retains the validated request parameters, product configuration, source, transformations, checkout expectation and reasons the checkout price may differ. Request contents exist only in the current response and private memory cache.

States: `VERIFIED QUOTE`, `AUTHORITATIVE PUBLIC RATE`, `ESTIMATE`, `UNAVAILABLE`, `ERROR`, `EXPIRED`.

`AUTHORITATIVE PUBLIC RATE` (shown as **Published rate**) means the number is the premium the insurer filed with the government for this plan year and CMS published, decoded unchanged. It is not an estimate, because nothing was modelled; it is not a personal quote, because it excludes any premium tax credit. The engine only accepts it from an adapter whose provenance is `published-rate` and which names a source ID, an integer plan year and an ISO publication date, and it rejects a `published-rate` provenance carrying any other status. EasyPost and the keyed CMS API produce **ESTIMATE**. The platform accepts `VERIFIED QUOTE` only from an adapter with `live-quote` provenance and a source reference; a future adapter must prove what its source guarantees. NHTSA output is vehicle data, never a quote. Missing prices do not become zero; unsupported currencies and test-mode shipping rates are excluded. An unavailable provider is a separate outcome, never an item in the price ranking. Provider errors have safe codes including `AUTH`, `RATE_LIMIT`, `TIMEOUT`, `MALFORMED`, `UNSUPPORTED`, `INVALID_INPUT`, `UNAVAILABLE`, `ADDITIONAL`.

Shipping uses EasyPost’s actual `rate`, not its retail/list rate. It is labeled an estimate because a ZIP-only, API-account-specific rate is not a purchasable offer to a Quote Scout visitor. There is no misleading carrier checkout link.

CMS uses the unsubsidized monthly premium. Annual premium is monthly × 12, **not estimated annual health spending**. Unknown or ambiguous individual in-network deductible/MOOP values remain unknown. Deductibles may exclude drug coverage and this is disclosed. Networks and formularies must be checked directly. CMS may paginate plan searches; when `total` exceeds returned plans, the UI explicitly limits its claim to the returned subset. There is no best-in-market claim.

## Comparison and ranking

Currencies never mix. Shipping is grouped by delivery guarantee and insurance-information status. Health is grouped by metal/type with a visible warning that networks and benefits differ. Users select a group before viewing its Top 3. Groups are ordered so the group holding the best option under the current ranking mode comes first, with the group key as a stable tie-break; the ordering picks the group to show first and is not a score comparing one product group with another. Every ranking mode explains its reasoning:

- Cheapest: price within the selected group.
- Shipping best value: cents + 100 × reported transit days. This explicit $1/day preference is not a carrier quality rating. Unknown delivery times sort last.
- Health best value: annual premium + individual in-network MOOP. A covered-care worst-case comparison, not expected spending or a recommendation about network fit. Unknown MOOP sorts last.
- Fastest: reported transit days, then price; no guarantee inferred.
- Lowest deductible: reported deductible, then premium; unknown sorts last.

Exact ties use price, verified status then a stable source ID. Commissions are not inputs. These deterministic modes do not use an LLM.

## Configuration and secrets

Shevato’s deployed provider secrets convention is a server-only Netlify Blob configuration, not a browser config file. In the **correct linked Netlify site**, configure store `quotescout`, key `config`, using the existing secure administration workflow. Never commit secrets or paste them into issue/PR bodies. The object supports:

- `cmsKey`: granted CMS Marketplace key; CMS documents rotation every 60 days.
- `easypostKey`: production key.
- `easypostPlatformApproved: true`: set only after EasyPost has approved this platform’s comparison/white-label use under the appropriate agreement.
- `carrierAccounts`: 1–10 approved EasyPost account IDs (`ca_…`). Required to prevent querying arbitrary carrier accounts.

Optional server environment overrides are `QUOTESCOUT_CMS_KEY` and `QUOTESCOUT_EASYPOST_KEY`. They do not override the agreement/carrier-account gates. Netlify runtime `context.deploy.context` (with `CONTEXT` as the local fallback) enables configured adapters in production. Runtime metadata wins over build environment values. Paid calls in other contexts require `QUOTESCOUT_ALLOW_LOCAL_PROVIDERS=1`; do not enable it on arbitrary deploy previews. This also permits localhost origins for deliberate local function testing. Environment keys are validated for length and whitespace. Missing/invalid configuration disables that provider.

Same-deploy Netlify preview origins can use the free vehicle tool without enabling paid adapters. VIN decoding does not need a key. Netlify Blobs must still be available to enforce rate limits. Never load the production `.env` in test fixtures. Static-only development displays the honest service-unavailable state.

## Caching and API cost protection

- Private quote cache: in process, maximum 250 entries. Key includes a SHA-256 of the random 256-bit per-tab capability, provider configuration, validated full input and adapter ID. No shared personalized quote cache. Capability lives in JS memory only and goes in a request header, never URL/storage/logs.
- EasyPost prices: 5 minutes; keyed CMS API: 15 minutes; bundled marketplace rates: 6 hours, because a filed rate does not change during the plan year; private vehicle response: 15 minutes. Retrieval timestamps survive cache hits. UI excludes expired prices and allows refresh.
- Enrichment: maximum 500 in-process entries; vPIC 30 days, CMS county/ZIP 24 hours. Hashed lookup keys, no durable VIN database. Expiry timers remove entries while a process is running; cold starts/eviction remove earlier. Only validated vehicle specifications are cached; the raw VIN-bearing response is discarded.
- Refresh bypasses quote caches, but concurrent identical in-flight requests share one operation. Safe VIN/geographic enrichment remains reusable.
- Metering applies to work that leaves the building. A comparison served entirely from the bundled dataset makes no upstream call and therefore keeps working when Netlify Blobs is unavailable; it is still counted against the ceiling whenever the store can record it, and is still bounded by the platform rate limit. A request that could reach a paid API is refused outright without an identity to meter.
- Quota store: one CAS-protected `usage` blob. 30 reservations per IP/hour; 1,000 total/day; 10,000/month; 200 EasyPost requests/day. The incoming comparison itself and each upstream attempt reserve separately. Reservations are conservatively not refunded on failure. No arbitrary request data goes into this blob.
- Daily-hashed IP identities are kept only within hourly counters, bounded at 1,000 identities. This is abuse protection, not anonymous user analytics. Aggregate monthly counters bound calls, **not a contractual dollar cap**; enforce account billing limits too.
- Netlify function edge rate limit: 40 requests/minute/IP, where supported by the hosting plan. Blob quotas remain authoritative across instances. Circuit breakers/deduplication/concurrency are process-local; distributed budgets remain effective across cold starts.

Responses use `private, no-store` and CDN no-store headers. No service worker caches Quote Scout requests.

## Privacy, security and observability

Read [SECURITY.md](SECURITY.md) and the Quote Scout section in `/privacy`. Browser form values stay in memory until submitted. No contact gate, no account dependency, no quote history sync. Fixed HTTPS upstreams and redirect rejection prevent user-controlled SSRF. Only the fixed HealthCare.gov plan-review URL is currently accepted for outbound quote actions; referrers are suppressed. No affiliate links exist.

Structured provider logs contain correlation UUID, vertical/provider IDs, safe outcome, latency, quote yield, verified/estimated counts, cache hit and question counts. Validation logs contain UUID and status only. Derive latency/success/timeout/cache/yield metrics from these events. The usage blob measures API call volume, not unreported provider fees. Standard Shevato analytics records app opens and outbound link clicks by domain through the existing helper, without input fields, prices or source quote IDs. No separate health/vehicle telemetry is added.

## Development and validation

No app build tool or new runtime dependency. Node 20+ and the root dev tools match Shevato. From repository root:

```
npm run lint
npm run test:quotescout
npm test
npm run build:quotescout:data
npm run test:browser -- --only=quotescout
npm run test:browser:parallel
npm run test:cross-browser
npm run test:coverage
npm run build:site
```

Use `netlify dev` for real function routing, with local configuration and explicitly enabled provider calls. Use an isolated checkout/copy for `build:site` because it generates pages and inlines shared HTML. No separate TypeScript checker exists; source parsing, ESLint and runtime contract tests are the applicable checks.

Tests use `node:test` and CDP. Deterministic upstream responses live exclusively under `tests/` and `e2e/`; no production switch can expose them. Forced 404 routes also block direct HTTP access to the Quote Scout test/E2E directories and function test sources under the root publish directory. The E2E suite covers minimal input, validation, vehicle decoding, Top 3/all results, sorting, refresh, additional county questions, errors, mobile overflow, contrast and axe checks. Browser screenshots live in ignored `.reports/`. Regenerate the committed empty-form preview deliberately with `QUOTESCOUT_UPDATE_PREVIEW=1 npm run build:quotescout:data
npm run test:browser -- --only=quotescout`; ordinary tests never rewrite that asset.

To check a real public source separately: `QUOTESCOUT_PUBLIC_API_TEST=1 node --test apps/quotescout/tests/sandbox.test.mjs`. It uses the documented sample VIN, never a user VIN. CMS/paid provider smoke tests require explicitly supplied local credentials and are not ordinary CI dependencies. Test-mode EasyPost prices must remain rejected in production even when a sandbox succeeds. See PROVIDERS.md for vendor access limitations.

## Adding an adapter or vertical

1. Verify official documentation and commercial use rights. Record geography, credential lifecycle, privacy terms, pricing, expiry and whether the offer can be purchased by the visitor.
2. Implement `{id,name,vertical,enabled,ttl,quote(input,context)}`. Context supplies `signal`, budgeted `reserve()` and safe `enrich()`. Use the fixed-host HTTP helper; do not accept endpoint URLs in configuration. Return normalized quotes, explicit errors or a bounded additional-question list. Never return raw upstream error bodies.
3. Define strict initial and provider-specific input schemas and server enrichment. Validate additional answers against current source data; never trust a browser-generated county, vehicle or coverage object.
4. Add required product comparison dimensions and explain any ranking score. Do not default unknown coverage to zero. Extend the engine’s outbound URL verification deliberately for any new checkout integration.
5. Register capability only when useful results are enabled. Add unit/API/privacy/browser fixtures, source documentation and deployment requirements. Insurance presets need partner-maintained jurisdiction/effective-date rules before enabling quoting; ZIP alone is not legal coverage validation.

## Deployment and release

Normal Shevato feature branch → PR → required green CI → merge workflow. No direct master edits. Deploy the source through the normal Netlify build, verify function bundling includes `@netlify/blobs`, confirm the store is available, then test the capabilities endpoint before configuring any paid adapter. Verify limits and approved carrier scope with provider accounts, rotate CMS keys, and perform a credential-backed contract test before advertising a Beta integration. Roll back an adapter by removing its key or agreement flag; the UI becomes unavailable without invented fallback rates. NHTSA remains independent.

External limitations are substantive: no commercial partners are established by this code; unconfigured verticals cannot quote; no subsidy, household enrollment, property enrichment, utility eligibility, internet availability or carrier binding is claimed. CI and deployment status must be reported from actual runs, not inferred from this document.
