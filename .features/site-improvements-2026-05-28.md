# Site Improvements — 2026-05-28

Branch: `feature/site-improv` · 8 site-level changes (marketing pages + apps hub + shared partials/SEO). **No app internals were touched.**

- **Local** = this branch served from `python3 -m http.server 8080` (the new behavior).
- **Prod** = the current live `shevato.com` (what exists *before* this branch merges).

The table below is what you should see **differently** between the two. Below the table is a step-by-step test script for every change, covering desktop + mobile, fonts, colors, spacing, and state changes.

---

## How to run locally before testing

```bash
cd /home/nikita/projects/shevato
python3 -m http.server 8080
# open http://127.0.0.1:8080/home.html
```

Test desktop at ≥1280px wide and mobile at ≤390px (DevTools device toolbar, e.g. iPhone 12 = 390×844). The breakpoint that flips desktop↔mobile nav is **736px**.

---

## Local vs Prod comparison table

| # | Change | Category | Prod (current live site) | Local (this branch) — what's different | Where to look |
|---|--------|----------|--------------------------|----------------------------------------|---------------|
| 1 | Inline desktop nav | UX / Visual | Desktop header shows only logo + "Menu" toggle | Desktop header shows **HOME / WORK / APPS / ABOUT / CONTACT** links inline; "Menu" toggle hidden ≥737px; the current page gets a blue underline mark. Now renders **on every page incl. all 6 apps** (no mark inside apps) | Header, all marketing pages **and apps**, ≥737px |
| 2 | App category filter | Feature / UX | 6 app cards, no filtering | Filter bar **All / Games / Fitness / Sports / TV**; clicking filters the cards live | `apps.html`, above the cards |
| 3 | Expanded footer | UX / Trust | Footer = single contact column + copyright | Footer gains a second **"Navigate"** column. It lists all 5 pages but **hides the one you're on** (inside an app → hides "Apps"), so it always shows **4** links | Footer, all pages incl. apps |
| 4 | moadon-alef RTL/SEO fix | SEO / A11y | `<html lang="en">`, no `twitter:site` | `<html lang="he" dir="rtl">` + `twitter:site` meta; lang-hiding CSS rule scoped so the root `lang` no longer blanks the page | `moadon-alef.html` source / `<head>` + the page renders en/ru/he |
| 5 | "How we engage" steps | Feature / Trust | A plain paragraph | 4 numbered process steps (01 Email → 02 Call → 03 Proposal → 04 Work begins) | `about.html`, "How to engage us" section |
| 6 | Home SEO upgrade | SEO | Old description; no SearchAction | Refreshed meta description + `SearchAction` in WebSite JSON-LD; sitemap `lastmod` = 2026-05-28 | `home.html` `<head>` / `sitemap-pages.xml` |
| 7 | Lazy-load Font Awesome | Performance | FA loaded via render-blocking `@import` in main.css | FA `@import` removed; loaded per-page via non-blocking `media="print"` swap + `<noscript>` | View-source `<head>`; icons still render |
| 8 | `aria-current` active nav | A11y | No "current page" indicator in nav | Active page link gets `aria-current="page"` + a readable **on-dark blue** highlight (and the underline mark in the inline nav), in both the desktop nav and the mobile menu. Not applied inside apps | Header nav + slide-in `#menu` |

> **Note on prod after merge:** Prod sends real security headers (`X-Frame-Options`, CSP-Report-Only) that localhost does not. None of these changes depend on those headers, so behavior is identical.

---

## Bonus fixes found during verification

**1. Contrast regression (nav active state).** The active-nav indicator (#1/#8) was initially set to `var(--brand-blue)` (`#0044cc`). On the near-black header that blue measured **2.54:1 contrast — a WCAG AA failure**, making the *active* link *less* legible than the inactive grey links (6.93:1). Fixed by adding a new token **`--brand-blue-on-dark: #4d8dff`** (≈6.2:1, same brand hue) in `brand-colors.css` and using it for the active link in both the desktop nav and the mobile `#menu`. The mobile-menu rule also had to be specificity-bumped (`#menu > ul.links > li > a[aria-current="page"]`) because the theme's `#menu > ul.links > li > a` was overriding it. Verified by computed-style readout: `rgb(77,141,255)`, font-weight 600.

**2. moadon-alef blank-page regression (caused by change #4).** Setting `<html lang="he">` triggered a latent bug: `moadon-alef-theme.css` had `[lang]:not([lang="en"]) { display: none; }` to hide per-element language variants. That unscoped selector also matched the new `<html lang="he">`, so it applied `display:none` to the **entire document** → a white blank page. (The JS in `language-switcher.js` already guarded `<html>`/`<body>` via `isStructuralLangHost`, but the *CSS* rule was never scoped, so the guard didn't cover this path.) **Fixed** by scoping the rule to `[lang]:not([lang="en"]):not(html):not(body)`. Verified: page now renders in English (default), Russian, and Hebrew/RTL — desktop + mobile — with the phone number staying LTR and the service cards correctly flowing right-to-left in Hebrew.

---

## Files changed

```
404.html                          about.html                 apps.html
assets/css/brand-colors.css       assets/css/main.css        assets/css/site.css
assets/css/moadon-alef-theme.css  assets/js/main.js          contact.html
home.html                         moadon-alef.html           partials/footer.html
partials/header.html              sitemap-pages.xml          work.html
```

`npm test` → **699 passed, 0 failed.**

---

## Step-by-step testing per change

For each, "✅ Expect" lists exactly what you should observe. Test **both** desktop (≥1280px) and mobile (≤390px) where noted.

### 1 — Inline desktop nav bar
1. Open `home.html` at ≥1280px.
2. ✅ Expect: five uppercase links **HOME WORK APPS ABOUT CONTACT** in the header. No clicking needed to see them.
3. ✅ Expect: the **"Menu"** hamburger toggle is **not** visible at this width.
4. Navigate to `work.html`. ✅ Expect: the **WORK** link is light blue (`#4d8dff`), bold, **and carries a 2px blue underline mark** directly beneath it; the others are dim grey with no underline. Check the mark follows you across Home/Work/Apps/About/Contact.
5. Press `Tab` from the address bar. ✅ Expect focus order: logo → Home → Work → Apps → About → Contact → auth. No focus trap.
6. Shrink the window to ≤736px. ✅ Expect: the inline links disappear and the **"Menu"** toggle reappears.
7. Font check: links are Raleway, uppercase, letter-spaced (~0.06em), ~0.82rem. Compare weight of active (600) vs inactive (500).
8. **On apps:** open any app (e.g. `/apps/mario-kart/`) at ≥1280px. ✅ Expect: the same inline nav renders and is styled (uppercase, the desktop "Menu" toggle is hidden), but **no underline mark** appears on any link (you're inside an app, not on one of the five pages). Spot-check all six apps.

### 2 — App category filter bar
1. `apps.html` desktop. ✅ Expect: a centered row of pill buttons **All / Games / Fitness / Sports / TV**; **All** is filled blue (active), others light grey.
2. Click **Games**. ✅ Expect: only **Mario Kart, MapTap Rivals, Arena** remain; Gym Tracker / Football H2H / Rising Seasons are hidden. "Games" turns blue, "All" goes grey.
3. Click **Fitness** → only **Gym Tracker**. Click **Sports** → only **Football H2H**. Click **TV** → only **Rising Seasons**.
4. Click **All**. ✅ Expect: all six cards return.
5. Accessibility: inspect the active button → ✅ `aria-pressed="true"`; inactive → `aria-pressed="false"`.
6. Resize to ≤480px. ✅ Expect: the bar **wraps to two rows** (TV drops to row 2), no overflow.

### 3 — Expanded footer
1. Scroll to the footer on any page, desktop. ✅ Expect **two columns**: a contact column (email, phone, LinkedIn) and a **"Navigate"** column.
2. ✅ Expect the Navigate column always shows **exactly 4** links — the link for the page you're on is **hidden**. On `home.html` → Work/Apps/About/Contact (no Home); on `work.html` → Home/Apps/About/Contact (no Work); etc.
3. **Inside an app** (e.g. `/apps/mario-kart/`) → the **"Apps"** link is the one hidden, leaving Home/Work/About/Contact.
4. Click the **LinkedIn** link. ✅ Expect: opens `https://www.linkedin.com/in/nikita-soifer/` in a **new tab** (`target="_blank"` + `rel="noopener noreferrer"`).
5. Click each Navigate link → lands on the right page.
6. ✅ Expect: the copyright line stays centered at the very bottom.
7. Resize ≤480px. ✅ Expect: the two columns **stack vertically**, copyright still centered.

### 4 — moadon-alef RTL + SEO
1. View-source `moadon-alef.html`. ✅ Expect line 2: `<html lang="he" dir="rtl">`.
2. ✅ Expect a `<meta name="twitter:site" content="@shevato" />` in `<head>`.
3. Open the page. ✅ Expect: **the page renders** (it must NOT be blank/white). Default content is **English**; the phone number `1-700-701-103` is **not mirrored** (it has `dir="ltr"`).
4. Click the **עברית** (Hebrew) button. ✅ Expect: content switches to Hebrew, the layout flips **right-to-left** (service cards reorder right→left), the phone stays LTR, and the עברית button goes active/green. Click **Русский** → Russian; **English** → back to English.
5. Test at ≥768px and ≤375px in each language. ✅ Expect: no broken/overlapping layout (theme is flex/centered, 0 floats — RTL-safe).

### 5 — "How we engage" process steps
1. `about.html`, scroll to **"How to engage us"**. ✅ Expect **4 numbered steps**: `01 Email us`, `02 Short call`, `03 Proposal`, `04 Work begins`, each with a short description.
2. Color check: the big step numbers (01–04) are a **faded brand-blue** (`rgba(0,68,204,0.35)`) — visible but not louder than the body text.
3. ✅ Expect: the blue **"Looking for an engineering partner?" CTA banner** is still present below the steps.
4. Resize ≤480px. ✅ Expect: each step stacks (number above text), no overflow.

### 6 — Home SEO upgrade
1. View-source `home.html`. ✅ Expect `<meta name="description">` = "Shevato LLC builds Spring Boot microservices, REST APIs, and full stack web applications for client teams, plus a growing set of free browser apps used daily." (158 chars, ≤160).
2. In the WebSite JSON-LD block, ✅ Expect a `potentialAction` → `SearchAction` with `urlTemplate` `https://shevato.com/apps.html?q={search_term_string}`.
3. Paste the page into Google's **Rich Results Test** (after deploy). ✅ Expect: no JSON-LD errors. (Locally verified: both JSON-LD blocks parse as valid JSON.)
4. `sitemap-pages.xml`: ✅ Expect `home.html` `<lastmod>` = `2026-05-28`.

### 7 — Lazy-load Font Awesome
1. View-source `assets/css/main.css` line 1. ✅ Expect: **no** `@import url(font-awesome.min.css)` (only the Raleway Google-font import + firebase-auth.css remain — those are intentional).
2. View-source each page `<head>`. ✅ Expect: `<link rel="stylesheet" href="/assets/css/font-awesome.min.css" media="print" onload="this.media='all'">` + a `<noscript>` fallback, on home/work/about/contact/apps/404/moadon.
3. Load each page normally. ✅ Expect: **all icons still render** (gamepad/heart on apps, envelope/phone/LinkedIn/GitHub on contact, "What we do" card icons on home).
4. DevTools → disable JavaScript → reload `contact.html`. ✅ Expect: icons still render (the `<noscript>` link kicks in).
5. (Optional) Lighthouse on `home.html` before/after merge. ✅ Expect: render-blocking-resources count drops by one; performance does not regress.

### 8 — `aria-current="page"` active nav (A11y)
1. `home.html` desktop, inspect the header **Home** link. ✅ Expect `aria-current="page"`; on other pages the matching link carries it instead.
2. Open the mobile **Menu** (≤736px). Inspect the link for the current page. ✅ Expect `aria-current="page"` **and** it renders in the readable on-dark blue (`rgb(77,141,255)`), bold — clearly distinct from the other grey menu links.
3. Screen-reader / a11y inspector: ✅ Expect the active link is announced as "current page".
4. ✅ Expect: no link whose href ≠ current page has `aria-current`.
5. **Inside an app** (`/apps/...`): ✅ Expect **no** link carries `aria-current` and no underline mark shows — none of the five nav targets is the page you're on.

---

## Verification note

All 8 changes — **including `moadon-alef.html`** — were screenshot-verified on desktop + mobile. moadon was verified in English (default), Russian, and Hebrew/RTL after the blank-page regression (see Bonus fix #2) was found and fixed.

The inline nav + expanded footer were verified on the marketing pages **and inside all six apps** (mario-kart, gym-tracker, football-h2h, rising-seasons, maptap-rivals, arena): the nav renders styled with the desktop "Menu" toggle hidden and no active mark, and the footer Navigate column hides the "Apps" link to show 4. These shared-partial styles live in `main.css` (not `site.css`) because apps load `main.css` but not `site.css`/`brand-colors.css`; the active-mark colors use `var(--brand-blue-on-dark, #4d8dff)` so they work without the token file.
