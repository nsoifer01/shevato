// Structural invariants for the visual, mobile and a11y fixes of the
// 2026-08-19 QA round.
//
// These are ASSET tests, in the estate's established "static asset text
// assertions" style: they pin the markup and CSS decisions that carry the fix,
// so a later refactor that quietly removes one fails here rather than only in
// the browser. The MEASURED behaviour (hit-testing, computed sizes, axe) is
// verified in `tests/browser/suites/apps.mjs` and `a11y.mjs`; both halves are
// needed, because a selector can exist and still measure wrong, and a
// measurement can pass on a build whose intent has been deleted.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/source-extract.mjs';

const html = loadSource('index.html');
const refresh = loadSource('css/refresh.css');
const base = loadSource('css/gym-tracker.css');
const css = `${base}\n${refresh}`;

/** Source with comments stripped, so prose about a selector is never read as
 *  the selector itself. */
const codeOnly = (text) => text
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');

/**
 * The LAST rule block for a selector, so assertions read the declarations that
 * actually win. Later rules of equal specificity beat earlier ones, and this
 * round's fixes are appended at the end of the sheet.
 */
function ruleFor(source, selector) {
    const i = source.lastIndexOf(selector);
    if (i === -1) return '';
    const open = source.indexOf('{', i);
    const close = source.indexOf('}', open);
    return source.slice(open, close);
}

// ---------------------------------------------------------------------------
// GT-05: the rest dial must not swallow taps
// ---------------------------------------------------------------------------

test('every non-interactive part of the rest dial ignores pointer events', () => {
    // The dial's 146px SVG ring covered the next exercise's weight and reps
    // columns and absorbed every tap on them for the whole rest period.
    const block = ruleFor(refresh, '#rest-timer-bar,');
    assert.match(block, /pointer-events: none/);
    for (const part of ['.rest-timer-dial', '.rest-timer-ring', '.rest-timer-dial-content']) {
        assert.ok(refresh.includes(part), `${part} must be in the pass-through list`);
    }
});

test('the dial\'s two buttons keep their pointer events', () => {
    const block = ruleFor(refresh, '.rest-timer-actions,');
    assert.match(block, /pointer-events: auto/);
});

test('the dial is translucent, so the row under it stays readable', () => {
    const block = ruleFor(refresh, 'body.gym-tracker .rest-timer-dial.rest-timer-dial,');
    assert.match(block, /backdrop-filter/);
    assert.match(block, /color-mix/);
});

// ---------------------------------------------------------------------------
// GT-09: the scheduled-day dot
// ---------------------------------------------------------------------------

test('the week-day pill pins its own line-height against the sitewide button rule', () => {
    // `assets/css/main.css` sets `button { line-height: 3.25rem }`, which
    // inflated the label's line box to 47.67px inside a 48px column-flex pill.
    const block = ruleFor(refresh, 'body.gym-tracker .week-day-pill {');
    assert.match(block, /line-height: 1\.2 !important/);
});

test('the scheduled-day dot cannot be shrunk to nothing', () => {
    // Both children were `flex-shrink: 1`; the label won and the dot rendered
    // 5px wide by 0px tall, so the feature looked broken.
    const block = ruleFor(refresh, 'body.gym-tracker .week-day-pill-dot {');
    assert.match(block, /flex: 0 0 6px/);
    assert.match(block, /min-height: 6px/);
});

// ---------------------------------------------------------------------------
// GT-17: the picker tray
// ---------------------------------------------------------------------------

test('the tray starts collapsed in the markup, not just after a render', () => {
    assert.match(html, /id="exercise-picker-tray" class="exercise-picker-tray is-collapsed"/);
    assert.match(html, /id="exercise-picker-tray-list"[^>]*hidden/);
});

test('the tray count is a real button with an expanded state', () => {
    assert.match(html, /id="exercise-picker-tray-count"[\s\S]{0,200}aria-expanded="false"/);
    assert.match(html, /aria-controls="exercise-picker-tray-list"/);
});

test('an expanded tray is capped and scrolls inside itself', () => {
    const block = ruleFor(refresh, 'body.gym-tracker .exercise-picker-tray-list {');
    assert.match(block, /max-height: 30vh/);
    assert.match(block, /overflow-y: auto/);
});

// ---------------------------------------------------------------------------
// GT-19: touch targets
// ---------------------------------------------------------------------------

test('the weight/reps field is the touch target, sized so its INNER box is 44px', () => {
    // 46px outer, 1px border each side -> 44px inner, which is what the
    // steppers and the number field inside it inherit.
    const block = ruleFor(refresh, 'body.gym-tracker .set-row-inputs .gt-stepper-group {\n    flex: 1 1 0;');
    assert.match(block, /height: 46px/);
    assert.match(block, /overflow: visible/, 'or the hit-area expanders are clipped');
});

test('the icon buttons carry a 44x44 hit area', () => {
    const block = ruleFor(refresh, 'body.gym-tracker .gt-iconbtn::after,');
    assert.match(block, /width: 44px/);
    assert.match(block, /height: 44px/);
});

test('the rest-timer buttons carry a 44px-tall hit area', () => {
    // Measured at 24px tall - the worst target in the app, pressed mid-rest.
    const block = ruleFor(refresh, 'body.gym-tracker .rest-timer-btn::after {');
    assert.match(block, /height: 44px/);
});

test('Finish workout and the unit toggle clear 44px', () => {
    assert.match(ruleFor(refresh, 'body.gym-tracker #finish-workout-btn {'), /min-height: 44px/);
    const unit = ruleFor(refresh, 'body.gym-tracker .workout-unit-btn {');
    assert.match(unit, /min-height: 44px/);
    assert.match(unit, /min-width: 44px/);
});

test('the steppers keep a usable width as well as a full-height box', () => {
    // The widths narrow with the viewport (the row must still hold "102.5"),
    // and every one of them is wider than the 26px the audit measured.
    const widths = [...codeOnly(refresh).matchAll(/\.set-row-inputs \.gt-stepper \{[\s\S]{0,120}?flex: 0 0 (\d+)px/g)]
        .map(m => Number(m[1]));
    assert.ok(widths.length >= 3, 'a base width plus the phone refinements');
    widths.forEach(w => assert.ok(w >= 30, `${w}px is not wider than the 26px the audit measured`));
    assert.equal(Math.max(...widths), 44, 'the widest case, once the reps field takes its own line');
    // The compact widths earn their 44px through a transparent expander.
    assert.match(refresh, /\.gt-stepper::after[\s\S]{0,200}height: 44px/);
});

// ---------------------------------------------------------------------------
// GT-20: the WEIGHT / REPS captions
// ---------------------------------------------------------------------------

test('the column captions are legible: bigger, and above 4.5:1', () => {
    // Measured 8.21px bold at 3.92:1 (#6f7785 on #14172a); 16 axe "serious"
    // nodes. #8b94a6 clears 4.5:1 on every surface the caption sits on.
    const block = ruleFor(refresh, 'body.gym-tracker .set-col-head {\n    flex: 1 1 0;');
    assert.match(block, /font-size: 0\.85rem/);
    assert.match(block, /color: #8b94a6/);
});

test('the caption colour really does clear WCAG AA on the app surfaces', () => {
    const luminance = (hex) => {
        const c = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16) / 255)
            .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => {
        const [l1, l2] = [luminance(a), luminance(b)].sort((x, y) => y - x);
        return (l1 + 0.05) / (l2 + 0.05);
    };
    for (const bg of ['#14172a', '#0a0c14', '#1a1e30']) {
        assert.ok(ratio('#8b94a6', bg) >= 4.5, `#8b94a6 on ${bg} is ${ratio('#8b94a6', bg).toFixed(2)}:1`);
    }
});

// ---------------------------------------------------------------------------
// GT-22: the inline feel prompt replaced the blocking modal
// ---------------------------------------------------------------------------

test('the blocking feel modal is gone from the markup', () => {
    assert.doesNotMatch(html, /id="feel-intro-modal"/,
        'a full-screen dialog after most exercises is a tap tax, not a celebration');
    assert.doesNotMatch(html, /id="feel-modal-good"/);
});

test('the inline prompt is styled and its buttons are real targets', () => {
    assert.ok(refresh.includes('.gt-feel-prompt'), 'the replacement must be styled');
    const block = ruleFor(refresh, 'body.gym-tracker .gt-feel-prompt-yes,');
    assert.match(block, /min-height: 44px/);
});

// ---------------------------------------------------------------------------
// GT-30: the 12-month heatmap on a phone
// ---------------------------------------------------------------------------

test('the phone heatmap uses fixed cell columns and scrolls', () => {
    // `repeat(N, 1fr)` fitted 53 week-columns into ~350px: ~4px cells with the
    // month labels running together and the last one clipped.
    assert.match(refresh, /--hm-weeks[\s\S]{0,120}12px\) !important/);
    const cell = ruleFor(refresh, 'body.gym-tracker .insights-heatmap .hm-cell {');
    assert.match(cell, /width: 12px/);
});

test('the renderer publishes the week count the breakpoint needs', () => {
    const insights = loadSource('js/views/insights-view.js');
    assert.match(insights, /setProperty\('--hm-weeks'/);
    assert.match(insights, /scrollLeft = host\.scrollWidth/, 'open on the most recent weeks');
});

// ---------------------------------------------------------------------------
// GT-35: the welcome tour
// ---------------------------------------------------------------------------

test('the tour opts the SCROLLING element into the back-to-top control', () => {
    // 2,116px of body in a ~574px viewport is exactly what it exists for - but
    // the header and footer sit outside the scroll, so the opt-in belongs on
    // `.onboarding-body`, not on the panel that contains it.
    assert.match(html, /class="modal-body onboarding-body" data-back-to-top/);
    assert.doesNotMatch(html, /onboarding-modal-content" data-back-to-top/);
});

test('the tour\'s footer action is lifecycle-aware, and watches the real scroller', () => {
    const app = loadSource('js/app.js');
    assert.match(app, /'Get started'/, 'a reader who finished the tour is not "skipping" it');
    assert.match(app, /scroller\.addEventListener\('scroll'/);
    assert.match(app, /onboarding-body/, 'watching the panel reads as "already read" at open');
});

// ---------------------------------------------------------------------------
// GT-37: toasts
// ---------------------------------------------------------------------------

test('toasts are anchored to the bottom, away from the next control', () => {
    // "Program saved successfully" landed over the Programs SORT row.
    const helpers = loadSource('js/utils/helpers.js');
    assert.match(helpers, /toast\.style\.bottom/);
    assert.doesNotMatch(helpers, /toast\.style\.top\s*=/, 'the top-pinned stack is gone');
    assert.match(refresh, /body\.gym-tracker \.toast \{[\s\S]{0,400}?top: auto !important/);
});

test('toasts clear the rest dial while it is on screen', () => {
    assert.ok(refresh.includes('body.gym-tracker.gt-rest-bar-visible .toast'));
});

// ---------------------------------------------------------------------------
// GT-41: the site auth modal, over the app
// ---------------------------------------------------------------------------

test('the auth modal is themed ONLY while the gym app owns the page', () => {
    // It is site-level markup shared with every other app and marketing page,
    // so an unscoped rule here would reach all of them.
    const lines = codeOnly(refresh).split('\n')
        .filter(line => /#auth-modal/.test(line));
    assert.ok(lines.length > 0, 'the dialog must be themed');
    lines.forEach((line) => {
        assert.match(line.trim(), /^body\.gym-tracker #auth-modal/,
            `an auth rule that is not gym-scoped: ${line.trim()}`);
    });
});

test('only the ACCENT is re-pointed; the shared light surface is left alone', () => {
    // firebase-auth.css pins `color-scheme: light` on these overlays on
    // purpose (Chrome's UA autofill/native-widget paint flips to dark inside
    // the white card otherwise) and a cross-app test enforces it. Forking that
    // per app would re-open the bug it closed.
    // Slice from the comment's OPENING delimiter, or codeOnly() cannot see a
    // block comment to strip and reads the prose as code.
    const authBlock = codeOnly(refresh.slice(refresh.indexOf('/* ---- GT-41')));
    assert.doesNotMatch(authBlock, /color-scheme/, 'the scheme pin is not ours to change');
    assert.doesNotMatch(authBlock, /auth-modal__content\s*\{[^}]*background/,
        'the surface stays as the shared component defines it');
    assert.match(authBlock, /--gt-accent-strong/, 'the CTA takes the app accent');
    assert.match(authBlock, /background-image: none !important/,
        'the purple/indigo gradient is what actually reads as a different product');
});

test('the shared color-scheme contract the theming defers to is still in place', () => {
    const shared = loadSource('../../assets/css/firebase-auth.css');
    assert.match(shared, /color-scheme: light !important/);
    assert.match(shared, /-webkit-autofill/);
});

// ---------------------------------------------------------------------------
// GT-02 / GT-04: markup the fixes depend on
// ---------------------------------------------------------------------------

test('the import-mode chooser exists, offers both operations, and is honest', () => {
    assert.match(html, /id="import-mode-modal"/);
    assert.match(html, /id="import-mode-merge"/);
    assert.match(html, /id="import-mode-replace"/);
    assert.match(html, /Anything not in the file is deleted/i,
        'replace must say what it does');
});

test('the import-mode modal sits before the confirm modal in document order', () => {
    // Every .modal shares z-index 2000, so document order IS stacking order:
    // the replace confirmation has to paint over the chooser.
    assert.ok(html.indexOf('id="import-mode-modal"') < html.indexOf('id="confirm-modal"'));
});

test('the finish summary has its own tile for time under tension', () => {
    assert.match(html, /id="summary-time-under-tension-stat"/);
    assert.match(html, /id="summary-time-under-tension"/);
});

// ---------------------------------------------------------------------------
// Ancillary observations from the same report
// ---------------------------------------------------------------------------

test('the search placeholders are short enough not to clip on a phone', () => {
    const placeholders = [...html.matchAll(/id="(exercise-search|swap-exercise-search|exercise-db-search)"[^>]*placeholder="([^"]*)"/g)];
    assert.equal(placeholders.length, 3, 'all three search fields');
    placeholders.forEach(([, id, text]) => {
        assert.ok(text.length <= 32, `${id}'s placeholder is ${text.length} chars and clipped at 390px`);
    });
});

test('the More-nav sync dot has a name and a tooltip', () => {
    const sync = loadSource('js/utils/sync-status.js');
    assert.match(sync, /aria-label.*Cloud sync/);
    assert.match(sync, /el\.title = `Cloud sync/);
});
