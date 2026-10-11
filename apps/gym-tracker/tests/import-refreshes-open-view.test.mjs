// An import re-renders the view it was started from (2026-10-11 audit).
//
// Imports start in Settings. app.importData used to reload memory and stop,
// so the Settings form and its dirty-check snapshot (savedSnapshot, taken in
// SettingsView.render) still held the PRE-import values; the next Save wrote
// them back over what had just been imported. The real app.js methods run
// here against the real StorageService; only the view controller is a stub.
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildMethods, extractClassMethod, loadSource } from './helpers/source-extract.mjs';

const disk = new Map();
globalThis.sessionStorage = globalThis.sessionStorage || { getItem: () => null, setItem() {} };
globalThis.localStorage = {
    getItem: (k) => (disk.has(k) ? disk.get(k) : null),
    setItem: (k, v) => { disk.set(k, String(v)); },
    removeItem: (k) => { disk.delete(k); },
};

const { storageService } = await import('../js/services/StorageService.js');
const { IMPORT_MODES, summarizeMerge } = await import('../js/utils/import-merge.js');

const toasts = [];
const appMethods = buildMethods(loadSource('js/app.js'),
    ['importData', 'refreshFromStorage', 'onViewChange'],
    { storageService, IMPORT_MODES, summarizeMerge, showToast: (m, type) => toasts.push({ m, type }) },
    'app.js');

test('importing from an open Settings view re-renders it with the imported settings', () => {
    storageService.saveSettings({ weightUnit: 'kg' });
    const rendered = [];
    const app = Object.create(appMethods);
    app.loadAllData = () => { app.settings = storageService.getSettings(); };
    app.loadAllData();
    app.updateAchievements = () => {};
    app.updateGlobalFab = () => {};
    app.runStoredDataMigrations = () => {};
    app.currentView = 'settings';
    app.viewControllers = { settings: { render: () => rendered.push(app.settings.weightUnit) } };

    assert.equal(app.importData({ version: '2.0', settings: { weightUnit: 'lb' } },
        { mode: IMPORT_MODES.REPLACE }), true);
    assert.deepEqual(rendered, ['lb'], 'Settings re-rendered once, from the imported values');
    assert.equal(toasts.at(-1).type, 'success');
});

test('SettingsView.render re-takes the dirty-check snapshot, so a re-render resets Save', () => {
    const render = extractClassMethod(loadSource('js/views/settings-view.js'), 'render', 'settings-view.js');
    assert.match(render, /this\.savedSnapshot = this\.snapshotForm\(\);\s*this\.checkDirty\(\);\s*\}$/);
});
