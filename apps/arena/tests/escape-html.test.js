'use strict';

// escapeHtml in apps/arena/js/app.js must escape BOTH quote characters.
//
// WHY: it was `div.textContent = value; return div.innerHTML`, which escapes
// &, < and > and leaves " and ' alone (a text node does not need them). That
// is safe only while every interpolation lands in element content, and arena
// does not: `app.js` renders another player's display name into
// `title="${escapeHtml(p.displayName)}"` on the podium and into
// `data-name="${...}"` in the recap. Display names are trimmed and capped at
// 20 characters, never quote-stripped, so a name like `x" onmouseover="..."`
// closed the attribute and planted an event handler in every OTHER player's
// browser. The site CSP is Report-Only and allows inline script, so nothing
// downstream would have stopped it.
//
// app.js is a browser module that touches the DOM at import time, so the
// function is extracted from source rather than imported. That is enough:
// what is being pinned is the escaping rule itself.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'app.js'), 'utf8');
const match = SRC.match(/function escapeHtml\(text\) \{[\s\S]*?\n\}/);
assert.ok(match, 'escapeHtml must still be a top-level function in app.js');
const escapeHtml = new Function(`return ${match[0].replace('function escapeHtml', 'function')}`)();

test('escapeHtml escapes both quote characters', () => {
    assert.equal(escapeHtml('x" onmouseover="alert(1)'), 'x&quot; onmouseover=&quot;alert(1)');
    assert.equal(escapeHtml("x' onmouseover='alert(1)"), 'x&#39; onmouseover=&#39;alert(1)');
});

test('escapeHtml still escapes the angle brackets and the ampersand', () => {
    assert.equal(escapeHtml('<img src=x onerror=pwn>'), '&lt;img src=x onerror=pwn&gt;');
    assert.equal(escapeHtml('Tom & Jerry'), 'Tom &amp; Jerry');
    // Ampersand first, or the entities themselves get double-escaped.
    assert.equal(escapeHtml('&lt;'), '&amp;lt;');
});

test('escapeHtml leaves ordinary names untouched and handles empties', () => {
    assert.equal(escapeHtml('Nikita'), 'Nikita');
    assert.equal(escapeHtml(''), '');
    assert.equal(escapeHtml(null), '');
    assert.equal(escapeHtml(undefined), '');
    assert.equal(escapeHtml(42), '42');
});

test('a hostile display name cannot break out of an attribute', () => {
    // The exact template from the podium renderer.
    const html = `<span class="podium-name" title="${escapeHtml('x" onmouseover="alert(1)')}">n</span>`;

    // Four quotes exactly: the two that delimit class, the two that delimit
    // title. Any more and the name has ended the attribute early, which is
    // how the handler used to become real markup.
    assert.equal((html.match(/"/g) || []).length, 4,
        `the name must not introduce quote characters: ${html}`);

    // And what is inside title= is one attribute value, not an attribute
    // followed by another attribute.
    const value = html.match(/title="([^"]*)"/)[1];
    assert.equal(value, 'x&quot; onmouseover=&quot;alert(1)');
});
