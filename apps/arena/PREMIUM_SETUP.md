# Brain Arena Premium — rollout checklist

The premium tier is fully implemented in code but **disabled in the UI**.
Every signed-in user sees every feature unlocked because
`Config.PREMIUM_UI_ENABLED` is `false`.

Note: **private password-protected rooms are free for everyone** — they
are not in this premium tier. The remaining premium features are
custom question packs and detailed post-game stats.

Files involved:

| File | Role |
|---|---|
| `js/config.js` | `PREMIUM_UI_ENABLED`, `STRIPE_CHECKOUT_URL`, trial duration, admin uids |
| `js/premium.js` | Pure helpers — trial math, status text, admin check (21 unit tests) |
| `js/app.js` | Wires the UI, gates features via `isPremium()`, snapshot listener on `users/{uid}` |
| `success.html` | Post-checkout return page; confirms premium when the webhook lands |
| `../../netlify/pending-functions/stripe-webhook.js` | Stripe → Firestore. Verifies signature, flips `triviaProfile.premium=true`. **Not deployed** — moved here so Netlify doesn't try to bundle firebase-admin. Activate by moving back to `netlify/functions/`. |
| `../../netlify/pending-functions/package.json` | Server-only deps: `stripe`, `firebase-admin` |

Tests stay green with the flag off — `premium.test.js` exercises the pure
helpers directly and doesn't touch the master switch.

---

## When you're ready to turn it on

### 0. Move the webhook into the Netlify build path

The function lives in `netlify/pending-functions/` so deploys stay green
while the tier is dormant. Move it back to where Netlify looks:

```bash
git mv netlify/pending-functions netlify/functions
```

If the first deploy after this move fails on `firebase-admin`, add to
`netlify.toml`:

```toml
[functions]
  node_bundler = "esbuild"
  external_node_modules = ["firebase-admin"]
```

### 1. Create the Firebase service account

Gives the webhook permission to flip `premium=true` on any user doc
(bypassing Firestore client-side rules).

1. https://console.firebase.google.com/project/shevato-site/settings/serviceaccounts/adminsdk
2. **Generate new private key** → **Generate key** → JSON downloads
3. Minify it to one line:
   ```bash
   cat ~/Downloads/shevato-site-firebase-adminsdk-*.json | jq -c .
   ```
4. Keep the one-liner safe — it is the equivalent of root access to Firestore.

### 2. Create the Stripe product + Payment Link

Use **test mode** first (toggle top-right of the Stripe Dashboard).

1. https://dashboard.stripe.com → **Product catalogue** → **+ Add product**
   - Name: `Brain Arena Premium`
   - Price: `$5.00 USD`, **One-time**
2. After saving, **Create payment link** on the product
   - **Confirmation page** → custom URL:
     `https://shevato.com/apps/brain-arena/success.html?paid=1`
3. Copy the resulting URL (looks like `https://buy.stripe.com/test_xxxxxxxx`)

### 3. Plug the URL into the app

Edit `apps/brain-arena/js/config.js`:

```diff
-PREMIUM_UI_ENABLED: false,
+PREMIUM_UI_ENABLED: true,
 ...
-STRIPE_CHECKOUT_URL: 'https://buy.stripe.com/test_placeholder_trivia_arena_premium',
+STRIPE_CHECKOUT_URL: 'https://buy.stripe.com/test_xxxxxxxx',
```

### 4. Grab the Stripe secret key

Stripe Dashboard → **Developers** → **API keys** → reveal **Secret key**
(starts with `sk_test_…`).

### 5. Add three Netlify environment variables

https://app.netlify.com → shevato site → **Site configuration** →
**Environment variables** → **Add a variable**:

| Key | Value |
|---|---|
| `STRIPE_SECRET_KEY` | `sk_test_…` from step 4 |
| `FIREBASE_SERVICE_ACCOUNT` | the single-line JSON from step 1 |
| `STRIPE_WEBHOOK_SECRET` | placeholder; you'll fill it in step 6 |

Trigger a redeploy so the function picks them up.

### 6. Register the webhook with Stripe

Needs a deployed URL, so do this **after** step 5 deploys.

1. Stripe Dashboard → **Developers** → **Webhooks** → **+ Add endpoint**
2. **Endpoint URL**: `https://shevato.com/.netlify/functions/stripe-webhook`
3. **Events to send** → check `checkout.session.completed`
4. After the endpoint is created, **Reveal** the **Signing secret**
   (starts with `whsec_…`)
5. Paste it into the `STRIPE_WEBHOOK_SECRET` Netlify env var
6. Redeploy so the function gets the secret

### 7. End-to-end smoke test (test mode)

1. Sign into Brain Arena, Profile → **Go Premium · $5**
2. Stripe Checkout uses test card `4242 4242 4242 4242`, any future expiry, any CVC
3. After paying, Stripe redirects to `success.html` — within ~2 seconds the
   page should show **"Premium is active on your account."**
4. Back at `/apps/brain-arena/` → Profile shows **"Premium active — …"**
5. If the webhook didn't land: Stripe Dashboard → Webhooks → click your
   endpoint → see the latest delivery and response body. Most failures
   are env var typos or `FIREBASE_SERVICE_ACCOUNT` not actually being
   single-line valid JSON.

### 8. (Optional) Promote yourself to admin

So you can flip premium / reset the trial without paying:

1. Sign in to Brain Arena. In DevTools console:
   ```js
   window.firebaseAuth.getCurrentUser().uid
   ```
2. Paste the uid into `apps/brain-arena/js/config.js`:
   ```js
   ADMIN_UIDS: ['paste-uid-here'],
   ```
3. Commit + redeploy. Refresh → the **Admin (dev)** panel appears below
   the premium card with **Grant paid premium / Reset trial clock**
   shortcuts.

### 9. Going live

After test mode works end-to-end:

1. Stripe Dashboard → flip to **Live mode** (top-right)
2. Re-do steps 2 (new live product + payment link), 4 (live `sk_live_…`),
   6 (live webhook + live `whsec_…`)
3. Update Netlify env vars to the live values
4. Update `Config.STRIPE_CHECKOUT_URL` to the live payment-link URL and commit

---

## How the trial behaves when you flip the switch later

Every user doc has `triviaProfile.signedUpAt` written on first load (the
`loadProfile` backfill in `app.js`). The trial window is measured from
that timestamp — so:

- **New accounts** after flipping the flag get the full 30 days, naturally.
- **Pre-existing accounts** that signed up before this code shipped also
  get a full 30 days, because `signedUpAt` is set by `serverTimestamp()`
  the first time they sign in after the flag flips.

If that's not what you want (e.g. you'd rather grandfather long-time
users into permanent premium), gate the backfill on account creation
time or run a one-off Admin SDK script before flipping the flag.

---

## Grandfathering active users (optional)

If you'd rather thank existing players with permanent premium instead
of starting their 30-day trial clock on launch day, run this once via
the Firebase Admin SDK before flipping `PREMIUM_UI_ENABLED`:

```js
// One-shot grandfather script. Marks every existing triviaProfile as
// paid premium so the launch-day flag flip doesn't reset their access.
// Run from a Node script with FIREBASE_SERVICE_ACCOUNT loaded.
const admin = require('firebase-admin');
admin.initializeApp({ credential: admin.credential.applicationDefault() });
const db = admin.firestore();
(async () => {
    const snap = await db.collection('users').get();
    const writer = db.bulkWriter();
    let count = 0;
    snap.forEach((doc) => {
        if (!doc.get('triviaProfile')) return;
        writer.update(doc.ref, {
            'triviaProfile.premium': true,
            'triviaProfile.premiumGrantedAt': admin.firestore.FieldValue.serverTimestamp(),
            'triviaProfile.premiumReason': 'grandfather'
        });
        count++;
    });
    await writer.close();
    console.log('Granted permanent premium to', count, 'profiles.');
})();
```

Keep the flag `false` while this runs so users don't see the upgrade UI
before the grant lands. Then proceed with the steps above.

---

## Pre-launch sanity checklist

Tick this before flipping `PREMIUM_UI_ENABLED: true` in production:

- [ ] `firestore.rules` deployed with the latest paths (incl. the new
      `triviaDaily`, `triviaDailyLeaderboard`, `triviaResults` collections).
- [ ] Stripe Payment Link in **live** mode (URL begins `https://buy.stripe.com/`
      WITHOUT `test_`).
- [ ] `STRIPE_SECRET_KEY` env var begins `sk_live_…`.
- [ ] `STRIPE_WEBHOOK_SECRET` is the **live** signing secret (`whsec_…`)
      from the live webhook endpoint — **not** the test secret.
- [ ] `FIREBASE_SERVICE_ACCOUNT` minifies to one valid JSON line and
      no longer mentions `private_key_id` containing `test`.
- [ ] Webhook endpoint URL points at production
      (`https://shevato.com/.netlify/functions/stripe-webhook`).
- [ ] Smoke test: real card → success page reads "Premium is active" within
      ~2 seconds → refresh `/apps/arena/` → profile shows "Premium active".
- [ ] (Optional) grandfather script above has run if you chose that path.

Once all boxes are ticked, change `Config.PREMIUM_UI_ENABLED` to `true`
and ship the deploy.

---

## Why the flag is still `false` after the Item #1 PR

The PR that bundled the 10-improvement batch (incl. this file's update)
*did not* activate billing. Activation needs three Netlify env vars and
a live Stripe Payment Link that the maintainer has to create — neither
the code nor an automated agent can produce those. Treat the flag flip
as a separate, explicitly-approved release step.
