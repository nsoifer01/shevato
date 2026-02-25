import globals from 'globals';
import eslintConfigPrettier from 'eslint-config-prettier';

export default [
  {
    // Global ignores
    ignores: [
      'node_modules/',
      'dist/',
      'public/',
      'assets/js/jquery.min.js',
      'assets/js/browser.min.js',
      'assets/js/breakpoints.min.js',
      'report_assets/',
      'report.html',
    ],
  },
  {
    // Default: all JS files treated as ES modules
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'module',
      globals: {
        ...globals.browser,
      },
    },
    rules: {
      // eslint:recommended core rules
      'constructor-super': 'error',
      'for-direction': 'error',
      'getter-return': 'error',
      'no-async-promise-executor': 'error',
      'no-case-declarations': 'warn', // TODO: upgrade to error after Phase 4 refactor
      'no-class-assign': 'error',
      'no-compare-neg-zero': 'error',
      'no-cond-assign': 'error',
      'no-const-assign': 'error',
      'no-constant-condition': 'error',
      'no-control-regex': 'error',
      'no-debugger': 'error',
      'no-delete-var': 'error',
      'no-dupe-args': 'error',
      'no-dupe-class-members': 'error',
      'no-dupe-else-if': 'error',
      'no-dupe-keys': 'error',
      'no-duplicate-case': 'error',
      'no-empty': 'warn',
      'no-empty-character-class': 'error',
      'no-empty-pattern': 'error',
      'no-ex-assign': 'error',
      'no-extra-boolean-cast': 'error',
      'no-fallthrough': 'error',
      'no-func-assign': 'error',
      'no-global-assign': 'error',
      'no-import-assign': 'error',
      'no-inner-declarations': 'warn', // TODO: upgrade to error after Phase 4 refactor
      'no-invalid-regexp': 'error',
      'no-irregular-whitespace': 'error',
      'no-loss-of-precision': 'error',
      'no-misleading-character-class': 'error',
      'no-new-symbol': 'error',
      'no-nonoctal-decimal-escape': 'error',
      'no-obj-calls': 'error',
      'no-octal': 'error',
      'no-prototype-builtins': 'warn',
      'no-redeclare': 'error',
      'no-regex-spaces': 'error',
      'no-self-assign': 'error',
      'no-setter-return': 'error',
      'no-shadow-restricted-names': 'error',
      'no-sparse-arrays': 'error',
      'no-this-before-super': 'error',
      'no-undef': 'warn',
      'no-unexpected-multiline': 'error',
      'no-unreachable': 'error',
      'no-unsafe-finally': 'error',
      'no-unsafe-negation': 'error',
      'no-unsafe-optional-chaining': 'error',
      'no-unused-labels': 'error',
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-useless-backreference': 'error',
      'no-useless-catch': 'error',
      'no-useless-escape': 'warn',
      'no-with': 'error',
      'require-yield': 'error',
      'use-isnan': 'error',
      'valid-typeof': 'warn', // TODO: upgrade to error after fixing existing issues

      // Security rules
      'no-eval': 'error',
      'no-implied-eval': 'error',
      'no-new-func': 'error',
      'no-script-url': 'error',

      // Console rules
      'no-console': ['warn', { allow: ['warn', 'error'] }],
    },
  },
  {
    // Legacy script files (IIFEs, global functions, no import/export)
    files: [
      'apps/mario-kart/js/!(boot).js',
      'apps/mario-kart/js/*/**/*.js',
      'apps/gym-tracker/js/gym-tracker-old.js',
      'assets/js/util.js',
      'assets/js/main.js',
      'assets/js/scripts.js',
      'assets/js/pagination.js',
      'assets/js/language-switcher.js',
      'assets/js/global-icons.js',
      'assets/js/year-updater.js',
      'assets/js/passive-events-fix.js',
      'assets/js/analytics.js',
      'sync-system/sync-debug.js',
      'sync-system/sync-loading-modal.js',
      'sync-system/sync-immediate.js',
      'sync-system/sync-modal-integration.js',
    ],
    languageOptions: {
      sourceType: 'script',
    },
  },
  {
    // Debug utilities and data files - allow console.log
    files: ['sync-system/sync-debug.js', 'apps/gym-tracker/data/**/*.js'],
    rules: {
      'no-console': 'off',
    },
  },
  // Prettier compatibility (must be last)
  eslintConfigPrettier,
];
