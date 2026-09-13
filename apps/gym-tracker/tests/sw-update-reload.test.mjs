/**
 * The update script in index.html reloads on a worker UPDATE, never on the
 * first install (audit G-6).
 *
 * sw.js calls skipWaiting() + clients.claim(), so every new worker takes over
 * open pages and fires `controllerchange`. For a page that was already
 * controlled that is an update: reload when no workout is live, otherwise show
 * the "Update available" toast. For a page that loaded with NO controller (a
 * first visit) the first `controllerchange` is just the install claiming it.
 *
 * The guard used to be flipped to true by `serviceWorker.ready`. `ready`
 * resolves as soon as the fresh worker starts activating, and its activate
 * handler only calls clients.claim() after pruning old caches, so the flag was
 * already true when the install's own controllerchange arrived. Every first
 * visit therefore reloaded itself and sent page_view, app_open and app_view
 * twice (observed live).
 *
 * The inline script is run for real in node:vm (the same approach as the
 * sw.js harness in sw-offline-behavior.test.mjs), with a fake
 * navigator.serviceWorker driven in the browser's order: ready resolves, THEN
 * the claim's controllerchange fires.
 */
process.env.TZ = 'UTC';

import vm from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadSource } from './helpers/source-extract.mjs';

const html = loadSource('index.html');
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map(m => m[1]);
const updateScript = scripts.filter(s => s.includes('navigator.serviceWorker.register('));
assert.equal(updateScript.length, 1, 'exactly one inline script registers the service worker');

/** A macrotask turn, so every pending promise callback has run. */
const drain = () => new Promise(resolve => setImmediate(resolve));

function boot({ controlled = false } = {}) {
    const swListeners = {};
    const winListeners = {};
    const state = { workoutLive: false, reloads: 0, toasts: [] };
    let resolveReady;
    const registration = { installing: null, addEventListener() {} };
    const serviceWorker = {
        controller: controlled ? { scriptURL: 'sw.js' } : null,
        ready: new Promise(resolve => { resolveReady = resolve; }),
        register: () => Promise.resolve(registration),
        addEventListener: (type, fn) => { (swListeners[type] ||= []).push(fn); },
    };
    const element = (tag) => ({
        tag, id: '', className: '', textContent: '', children: [],
        setAttribute() {}, addEventListener() {},
        appendChild(child) { this.children.push(child); },
    });
    const sandbox = {
        window: { addEventListener: (type, fn) => { (winListeners[type] ||= []).push(fn); } },
        navigator: { serviceWorker },
        location: { reload: () => { state.reloads += 1; } },
        document: {
            querySelector: (sel) => (sel === '#active-workout.active' && state.workoutLive ? {} : null),
            getElementById: (id) => state.toasts.find(el => el.id === id) || null,
            createElement: element,
            body: { appendChild: (el) => { state.toasts.push(el); } },
        },
    };
    vm.createContext(sandbox);
    vm.runInContext(updateScript[0], sandbox, { filename: 'index.html (inline update script)' });

    return {
        state,
        async load() {
            (winListeners.load || []).forEach(fn => fn());
            await drain();
        },
        /** A worker finished installing and is activating: `ready` settles first. */
        async activate() {
            resolveReady(registration);
            await drain();
        },
        /** clients.claim() (or a later update's claim) changed the controller. */
        async claim() {
            serviceWorker.controller = { scriptURL: 'sw.js' };
            (swListeners.controllerchange || []).forEach(fn => fn());
            await drain();
        },
    };
}

test('first visit: the install claiming the page does NOT reload it', async () => {
    const page = boot({ controlled: false });
    await page.load();
    await page.activate();
    await page.claim();
    assert.equal(page.state.reloads, 0, 'a first install reloaded the page (double page_view)');
    assert.equal(page.state.toasts.length, 0, 'and it is not an update, so no toast either');
});

test('a controlled page reloads when an updated worker takes over and no workout is live', async () => {
    const page = boot({ controlled: true });
    await page.load();
    await page.activate();
    await page.claim();
    assert.equal(page.state.reloads, 1);
});

test('a controlled page mid-workout shows the update toast instead of reloading', async () => {
    const page = boot({ controlled: true });
    await page.load();
    page.state.workoutLive = true;
    await page.claim();
    assert.equal(page.state.reloads, 0, 'a reload is never forced mid-workout');
    assert.equal(page.state.toasts.length, 1);
    assert.equal(page.state.toasts[0].id, 'gym-update-toast');
});

test('first visit, then a later update in the same page: only the update reloads', async () => {
    const page = boot({ controlled: false });
    await page.load();
    await page.activate();
    await page.claim();
    assert.equal(page.state.reloads, 0, 'the install claim is not an update');
    await page.claim();
    assert.equal(page.state.reloads, 1, 'the next worker is an update and must reload');
});

test('a second controllerchange while a reload is already under way does not reload again', async () => {
    const page = boot({ controlled: true });
    await page.claim();
    await page.claim();
    assert.equal(page.state.reloads, 1);
});
