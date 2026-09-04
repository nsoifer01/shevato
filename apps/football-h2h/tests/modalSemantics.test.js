'use strict';

// Dialog and toast semantics for assistive technology.
//
// WHY: modalUtils built `div.modal-overlay > div.modal-dialog` with no role,
// no aria-modal and no accessible name, and the toasts had no live region.
// The focus trap and the Escape handler were already correct, so a keyboard
// user could operate the dialog; what was missing is anything that TELLS a
// screen reader a dialog opened, or reads out "Game added successfully!" and
// every error message. Football H2H was the only app in the repo with zero
// `aria-modal` attributes (arena 3, fpl 2, gym 16, maptap 5, mario 3,
// rising 4, trip 12).
//
// The builders touch document/body, so this runs them against a small DOM
// stand-in and reads back the attributes they set.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function makeElement(tag) {
    const el = {
        tagName: String(tag).toUpperCase(),
        className: '',
        style: { cssText: '' },
        children: [],
        attributes: {},
        innerHTML: '',
        textContent: '',
        setAttribute(name, value) { this.attributes[name] = String(value); },
        getAttribute(name) { return Object.prototype.hasOwnProperty.call(this.attributes, name) ? this.attributes[name] : null; },
        removeAttribute(name) { delete this.attributes[name]; },
        appendChild(child) { this.children.push(child); return child; },
        removeChild(child) { this.children = this.children.filter((c) => c !== child); },
        querySelector() { return null; },
        querySelectorAll() { return []; },
        addEventListener() {},
        removeEventListener() {},
        focus() {},
        contains() { return false; },
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    };
    return el;
}

function loadModalUtils() {
    const created = [];
    const body = makeElement('body');
    const documentStub = {
        body,
        documentElement: makeElement('html'),
        createElement: (tag) => { const el = makeElement(tag); created.push(el); return el; },
        getElementById: () => null,
        querySelector: () => null,
        querySelectorAll: () => [],
        addEventListener: () => {},
        removeEventListener: () => {},
        activeElement: null,
        head: makeElement('head'),
    };
    const windowStub = {
        // modalUtils escapes through the shared assets/js/escape-html.js,
        // which the page loads before it.
        escapeHtml: (v) => String(v == null ? '' : v).replace(/[&<>"']/g, (ch) => ({
            '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
        }[ch])),
        addEventListener: () => {}, removeEventListener: () => {},
        getComputedStyle: () => ({ getPropertyValue: () => '' }),
        setTimeout, clearTimeout, requestAnimationFrame: (fn) => setTimeout(fn, 0),
        scrollTo: () => {}, pageYOffset: 0, innerHeight: 800,
    };
    const ctx = vm.createContext({
        window: windowStub, document: documentStub, console,
        setTimeout, clearTimeout, requestAnimationFrame: windowStub.requestAnimationFrame,
    });
    ctx.globalThis = ctx;
    Object.assign(ctx, windowStub);
    const src = fs.readFileSync(path.join(__dirname, '..', 'js', 'modalUtils.js'), 'utf8');
    vm.runInContext(src, ctx);
    return { ctx, body, created };
}

test('a dialog announces itself: role, aria-modal and an accessible name', () => {
    const { ctx, body } = loadModalUtils();
    ctx.createConfirmationModal({
        icon: '❌', title: 'Delete Game', message: 'Are you sure?',
        onConfirm: () => {}, onCancel: () => {},
    });

    const overlay = body.children.at(-1);
    assert.ok(overlay, 'the overlay must be appended to the body');
    const dialog = overlay.children[0];
    assert.equal(dialog.getAttribute('role'), 'dialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');

    const labelledBy = dialog.getAttribute('aria-labelledby');
    assert.ok(labelledBy, 'the dialog must name itself');
    assert.ok(
        dialog.innerHTML.includes(`id="${labelledBy}"`),
        `aria-labelledby="${labelledBy}" must point at an element that exists: ${dialog.innerHTML}`
    );
    assert.ok(dialog.innerHTML.includes('Delete Game'), 'and that element holds the title');
});

test('an error dialog is an alertdialog so it interrupts', () => {
    const { ctx, body } = loadModalUtils();
    ctx.createErrorModal({ title: 'Import failed', message: 'That file is not readable.' });
    const dialog = body.children.at(-1).children[0];
    assert.equal(dialog.getAttribute('role'), 'alertdialog');
    assert.equal(dialog.getAttribute('aria-modal'), 'true');
});

test('two dialogs in one session get distinct label ids', () => {
    // A fixed id would make the second dialog point at the first one's title.
    const { ctx, body } = loadModalUtils();
    ctx.createConfirmationModal({ icon: '❌', title: 'First', message: 'a', onConfirm: () => {} });
    const first = body.children.at(-1).children[0].getAttribute('aria-labelledby');
    ctx.createConfirmationModal({ icon: '❌', title: 'Second', message: 'b', onConfirm: () => {} });
    const second = body.children.at(-1).children[0].getAttribute('aria-labelledby');
    assert.notEqual(first, second, 'each dialog needs its own title id');
});

test('toasts are live regions, and errors are assertive', () => {
    const { ctx, body } = loadModalUtils();

    ctx.showToast('Game added successfully!', 'success');
    const success = body.children.at(-1);
    assert.equal(success.getAttribute('role'), 'status');
    assert.equal(success.getAttribute('aria-live'), 'polite');

    ctx.showToast('Not saved: this device is out of storage space.', 'error');
    const error = body.children.at(-1);
    assert.equal(error.getAttribute('role'), 'alert');
    assert.equal(error.getAttribute('aria-live'), 'assertive');
});
