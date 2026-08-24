'use strict';

// The modal layer is the renderer that used to interpolate stored strings
// raw (stored XSS in the edit / delete modals, and a `"` in a note that
// truncated the field on every Edit). These tests render through the REAL
// renderer (js/modalUtils.js renderFormFieldsHtml, the same string
// createFormModal injects) with the REAL shared escape helper, and then
// drive the real editGame() save path with what a browser would read back
// out of that markup.

process.env.TZ = 'UTC';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { makeContext, loadInto, runIn, toHost, storedGames } = require('./vm-harness.js');

const HOSTILE = 'x"><img src=x onerror=window.__xss=1>';
const QUOTES = `He said "nice" & 'ok' <b>`;

// What a browser does with the value="..." attribute of the rendered input:
// extract it and decode the character references. A value that survives
// this round trip unchanged is what the user sees in the field.
function decodeEntities(s) {
    return s.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
}
function attr(html, id, name = 'value') {
    const re = new RegExp(`<(?:input|select)[^>]*id="${id}"[^>]*\\s${name}="([^"]*)"`);
    const m = html.match(re);
    assert.ok(m, `no ${name} attribute found for #${id} in: ${html.slice(0, 300)}`);
    return decodeEntities(m[1]);
}

function rendererCtx() {
    const ctx = makeContext();
    loadInto(ctx, 'match-logic.js');
    loadInto(ctx, 'modalUtils.js');
    return ctx;
}

test('renderer: a hostile text value creates no element and round-trips verbatim', () => {
    const ctx = rendererCtx();
    const html = ctx.renderFormFieldsHtml([{ id: 'note', type: 'text', label: 'Note (optional)', value: HOSTILE, maxlength: 80 }]);
    assert.ok(!/<img/i.test(html), `an <img> element was created: ${html}`);
    assert.ok(!/onerror=/.test(html.replace(/value="[^"]*"/, '')), 'onerror must only ever appear inside the escaped attribute');
    assert.equal(attr(html, 'form-note'), HOSTILE);
});

test('renderer: quotes and ampersands in a value survive the attribute (the truncation bug)', () => {
    const ctx = rendererCtx();
    const html = ctx.renderFormFieldsHtml([{ id: 'player1Team', type: 'text', label: "Al's Team", value: 'Bob"s XI & Co' }]);
    assert.equal(attr(html, 'form-player1Team'), 'Bob"s XI & Co');
});

test('renderer: labels, section titles, option text and placeholders are escaped', () => {
    const ctx = rendererCtx();
    const name = 'Al<img src=x onerror=window.__xssName=1>';
    const html = ctx.renderFormFieldsHtml([
        { id: 'player1Goals', type: 'number', label: `${name} Goals`, value: 1, min: '0', max: '99' },
        { id: 'penaltyWinner', type: 'select', label: 'Penalty Result', value: '', options: [{ value: '1', text: `${name} Won` }] },
        { id: 'note', type: 'text', label: 'Note', value: '', placeholder: `<b>${name}</b>` },
    ]);
    assert.ok(!/<img/i.test(html), `an <img> element was created: ${html}`);
    assert.ok(!/<b>/.test(html), 'placeholder markup must be escaped');
    assert.ok(html.includes('&lt;img src=x onerror=window.__xssName=1&gt;'), 'the name is shown as text');
});

// --- full round trip through editGame() --------------------------------

// Loads the app, seeds one game with the given note / custom team, and
// wires createFormModal to the real renderer so the captured markup is
// exactly what the browser would receive.
function appCtx(seed) {
    const captured = { html: null, opts: null };
    const ctx = makeContext();
    loadInto(ctx, 'playerStats.js');
    loadInto(ctx, 'match-logic.js');
    loadInto(ctx, 'modalUtils.js');
    loadInto(ctx, 'football-h2h.js');
    // modalUtils.js publishes the real createFormModal (which needs a DOM);
    // capture its input and render it through the real field renderer.
    ctx.createFormModal = (opts) => {
        captured.opts = opts;
        captured.html = ctx.renderFormFieldsHtml(opts.fields);
    };
    ctx.showFormError = (msg) => { throw new Error('unexpected form error: ' + msg); };
    ctx.hideFormError = () => {};
    ctx.updateUI = () => {};
    runIn(ctx, `games = ${JSON.stringify([seed])}; window.games = games;`);
    ctx.saveGames();
    return { ctx, captured };
}

const SEED = {
    id: 1, gameNumber: 1, player1Goals: 2, player2Goals: 0,
    player1Team: 'Bob"s XI', player2Team: 'Ultimate Team', penaltyWinner: null,
    dateTime: '2026-01-10T15:00:00.000Z', note: QUOTES,
};

// Open the edit modal, read every field back the way the browser would,
// and save without changes.
function openReadSave(h) {
    h.ctx.editGame(1);
    const html = h.captured.html;
    const formData = {};
    for (const f of h.captured.opts.fields) {
        if (f.type === 'select') {
            formData[f.id] = f.value; // the selected option's value
        } else {
            formData[f.id] = attr(html, `form-${f.id}`);
        }
    }
    assert.equal(h.captured.opts.onSave(formData), undefined, 'a no-op save must succeed');
    return html;
}

test('edit round trip: create -> render -> save -> render -> save keeps a quoted note and team unchanged', () => {
    const h = appCtx(SEED);
    const first = openReadSave(h);
    assert.equal(attr(first, 'form-note'), QUOTES);
    assert.equal(attr(first, 'form-player1Team'), 'Bob"s XI');
    assert.equal(toHost(runIn(h.ctx, 'games[0]')).note, QUOTES, 'first no-op save must not truncate');

    const second = openReadSave(h);
    assert.equal(attr(second, 'form-note'), QUOTES, 'the second edit sees the full note');
    const stored = storedGames(h.ctx)[0];
    assert.equal(stored.note, QUOTES);
    assert.equal(stored.player1Team, 'Bob"s XI');
});

test('edit modal: stored HTML in a note, team and player name renders as text, never as elements', () => {
    const name = 'Al<img src=x onerror=window.__xssName=1>';
    const h = appCtx({ ...SEED, note: HOSTILE, player1Team: HOSTILE });
    runIn(h.ctx, `player1Name = ${JSON.stringify(name)}; window.player1Name = player1Name;`);
    h.ctx.editGame(1);
    const html = h.captured.html;
    assert.ok(!/<img/i.test(html), `an <img> element was created: ${html}`);
    assert.equal(attr(html, 'form-note'), HOSTILE);
    assert.equal(attr(html, 'form-player1Team'), HOSTILE);
    assert.ok(html.includes('Al&lt;img'), 'the player name appears escaped in labels');
});

test('delete modal: the confirmation message escapes the stored player names', () => {
    const name = 'Al<img src=x onerror=window.__xssName=1>';
    let message = null;
    const ctx = makeContext({ createConfirmationModal: (opts) => { message = opts.message; } });
    loadInto(ctx, 'playerStats.js');
    loadInto(ctx, 'match-logic.js');
    loadInto(ctx, 'football-h2h.js');
    runIn(ctx, `games = ${JSON.stringify([SEED])}; window.games = games; player1Name = ${JSON.stringify(name)};`);
    ctx.deleteGame(1);
    assert.ok(message, 'the confirm modal must open');
    assert.ok(!/<img/i.test(message), `an <img> element was created: ${message}`);
    assert.ok(message.includes('Al&lt;img src=x onerror=window.__xssName=1&gt;'));
});
