// Correctness gate, not a style gate.
//
// `no-undef` is the only rule enabled, and it exists here because of one
// production bug: `wasOpen = isVisible` survived a rename to `menuOpen` through
// a merge, main.js is 'use strict', and the resulting dead store to an
// undeclared binding threw a ReferenceError on every mobile menu open and close
// for 12 days. Nothing in the estate caught it: `npm test` never opens a
// browser, and the browser suites only checked JS errors at moments that throw
// could not reach. This rule catches that class in about 8 seconds, statically,
// before the code is ever run.
//
// Deliberately NOT here: formatting, style, or opinionated presets. No
// Prettier, no Airbnb, no `eslint:recommended`. Adding a rule means measuring
// its noise against this codebase first, the way `no-undef` was measured.
import globals from 'globals';

// The two oldest apps are classic multi-script pages: index.html loads 10+
// sibling <script> tags that share state through window globals rather than
// modules. Every name below IS defined, in a sibling script loaded on the same
// page, so `no-undef` cannot see it. Declaring them is bookkeeping, not
// suppression. The honest alternative is converting both apps to ES modules,
// which is a large change to two working apps and is not justified by lint.
const footballH2hGlobals = [
  'addToHistory', 'createConfirmationModal', 'createErrorModal', 'createFormModal',
  'createModal', 'createSuccessModal', 'createWarningModal', 'escapeHtml', 'games',
  'hideFormError', 'initializeAutoBackup', 'lockBodyScroll', 'player1Name',
  'player2Name', 'playerIcons', 'resetActionHistory', 'saveGames', 'showFormError',
  'showToast', 'trapFocus', 'unlockBodyScroll', 'updateUI', 'updateUndoRedoButtons',
];

const marioKartGlobals = [
  'MAX_POSITIONS', 'MIN_POSITIONS', 'actionHistory', 'addRace',
  'autoBackupToLocalStorage', 'calculateStats', 'clearAllVisualizationBars',
  'closeSidebarPlayerSettings', 'compareRacesChronologically', 'createAllBars',
  'createAnalysisView', 'createHeatmapView', 'createTrendCharts',
  'currentDateFilter', 'currentView', 'escapeHtml', 'exportData',
  'formatDateForDisplay', 'formatDecimal', 'generateDailyH2HTable',
  'generateH2HTable', 'getFilteredRaces', 'getPlayerName', 'getStatClass',
  'highestPlayerWithRaces', 'importData', 'initializeAutoBackup', 'isFinitePosition',
  'loadData', 'openSidebar', 'openSidebarIconPicker', 'openSidebarPlayerSettings',
  'playerCount', 'playerNames', 'players', 'presentModal', 'raceDateTimeValue',
  'races', 'refreshPlayerRoster', 'resetActionHistory', 'sanitizePlayerNames',
  'sanitizeRaceData', 'saveAction', 'setDateFilter', 'showMessage',
  'summarizeRepairs', 'toggleView', 'updateAchievements', 'updateClearButtonState',
  'updateDisplay', 'updateInputGroupClass', 'updatePlayerCount',
  'updatePlayerFieldsVisibility', 'updatePlayerLabels', 'updatePlayerName',
  'updateUndoRedoButtons',
];

const risingShowsGlobals = ['RisingShowsFinder', 'RisingShowsIntegrations', 'detectShapes'];
const tripPlannerGlobals = ['isPdf'];

// Provided by a script we do not own: `Chart` and `L` (Leaflet) come from a
// CDN, `breakpoints` from the vendored assets/js/breakpoints.min.js, and
// `Globe` from apps/arena/js/vendor/globe.gl.min.js. All are covered by the
// `**/*.min.js` and `**/vendor/**` ignores, so nothing declares them.
const vendorGlobals = {
  Chart: 'readonly', L: 'readonly', breakpoints: 'readonly', Globe: 'readonly',
};

// Several app files are deliberately dual-exposed: they run as a classic
// browser script AND are require()d by node tests, via a
// `typeof module !== 'undefined' && module.exports = ...` footer. The guard
// means these names are safe to reference even in the browser, where they do
// not exist.
// `process` joins them for the same reason: fpl-planner's backtest engine is
// imported by both node scripts and the browser bundle, and its node-only
// paths sit behind `typeof process === 'undefined'` guards.
const dualExposureGlobals = {
  module: 'readonly', require: 'readonly', exports: 'readonly', process: 'readonly',
};

const asReadonly = (names) => Object.fromEntries(names.map((n) => [n, 'writable']));

export default [
  {
    // The codebase already carries `eslint-disable` comments for rules this
    // config deliberately does not enable yet (no-unused-vars, no-console,
    // no-await-in-loop). They are notes for the Phase 2 rules, not mistakes,
    // so do not report them as unused.
    linterOptions: { reportUnusedDisableDirectives: 'off' },
  },
  {
    ignores: [
      'node_modules/**',
      // Vendored third-party bundles. Minified, not ours to fix, and their UMD
      // wrappers reference an AMD `define` that legitimately may not exist.
      '**/*.min.js',
      '**/vendor/**',
      // Generated at deploy time by build:site, never hand-edited, and absent
      // from a fresh clone.
      'apps/rising-shows/shows/**',
      'apps/gym-tracker/exercises/**',
      'apps/rising-shows/data/**',
    ],
  },

  // Browser code: the site chrome, every app's front end, and the sync system.
  // Classic scripts by default, because that is what the older apps and all of
  // assets/js still are.
  {
    files: ['assets/**/*.js', 'apps/*/js/**/*.js', 'sync-system/**/*.js', 'firebase-config.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser, ...globals.jquery, ...vendorGlobals, ...dualExposureGlobals,
      },
    },
    rules: { 'no-undef': 'error' },
  },

  // ...except the parts of the estate that really are ES modules. Measured,
  // not assumed: fpl-planner (52 of 52 files) and gym-tracker (50 of 50) are
  // fully modular, arena mixes one module entry point with 12 dual-exposed
  // classic scripts, and these three root/sync files use import/export.
  {
    files: [
      'apps/fpl-planner/js/**/*.js',
      'apps/gym-tracker/js/**/*.js',
      'apps/arena/js/**/*.js',
      'firebase-config.js',
      'sync-system/app-sync-init.js',
      'sync-system/storage-sync-robust.js',
    ],
    languageOptions: { sourceType: 'module' },
  },
  { files: ['apps/football-h2h/js/**/*.js'], languageOptions: { globals: asReadonly(footballH2hGlobals) } },
  { files: ['apps/mario-kart/js/**/*.js'], languageOptions: { globals: asReadonly(marioKartGlobals) } },
  { files: ['apps/rising-shows/js/**/*.js'], languageOptions: { globals: asReadonly(risingShowsGlobals) } },
  { files: ['apps/trip-planner/js/**/*.js'], languageOptions: { globals: asReadonly(tripPlannerGlobals) } },

  // Service workers get their own globals (self, clients, caches).
  {
    files: ['**/sw.js', '**/service-worker.js'],
    languageOptions: { globals: { ...globals.serviceworker } },
  },

  // Node code: build scripts, netlify functions, and every test layer.
  {
    files: [
      'scripts/**/*.{js,mjs,cjs}', 'netlify/**/*.{js,mjs,cjs}', 'tests/**/*.{js,mjs,cjs}',
      'apps/*/tests/**/*.{js,mjs,cjs}', 'apps/*/tests-rules/**/*.{js,mjs,cjs}',
      'apps/*/scripts/**/*.{js,mjs,cjs}', 'apps/*/e2e/**/*.{js,mjs,cjs}',
      'sync-system/tests/**/*.{js,mjs,cjs}', 'assets/**/tests/**/*.{js,mjs,cjs}',
      'assets/og/**/*.mjs', 'eslint.config.mjs',
    ],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      // `window` because the dual-exposed logic files (and the tests that
      // exercise them) branch on it to decide whether they are in a browser.
      globals: { ...globals.node, window: 'readonly', document: 'readonly' },
    },
    rules: { 'no-undef': 'error' },
  },
  // .cjs and the handful of classic-script .js helpers under Node are CommonJS.
  {
    files: ['**/*.cjs', 'scripts/**/*.js', 'netlify/**/*.js', 'apps/*/scripts/**/*.js'],
    languageOptions: { sourceType: 'commonjs' },
  },
];
