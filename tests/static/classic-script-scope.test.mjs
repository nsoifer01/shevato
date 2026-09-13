// Every classic script on a page shares ONE global lexical scope. Check each
// published page's scripts together, the way the browser loads them.
//
// A plain (non-module) <script> does not get a scope of its own: its top-level
// `const`, `let` and `class` declarations land in the page's single global
// lexical scope, and its `var` and function declarations on the global object.
// When a later script declares a name an earlier one already holds, the browser
// refuses the WHOLE later script before running a line of it:
//
//     SyntaxError: Identifier 'API' has already been declared
//
// Nothing in that script runs, so whatever it exports never exists, and the
// visible failure is a ReferenceError somewhere else entirely. On PR #530
// scripts/match.js gained a top-level `const API` that finder-lib.js already
// declared, and the Rising Shows finder rendered nothing while 6,331 unit tests
// and the lint gate were green: every file require()s cleanly on its own, which
// is the only way the unit estate ever loads them. The guard that PR added read
// one page's `scripts/*.js` tags; the Kometa builder (which loads
// integrations-lib.js, declaring `const API` too, as a classic script), Mario
// Kart's 44 classic scripts, Football H2H's 23 and every site script stayed
// outside it.
//
// HOW THIS SIMULATES THE BROWSER WITHOUT RUNNING ANYONE'S CODE
// ------------------------------------------------------------
// The redeclaration check is part of instantiating a script (the spec's
// GlobalDeclarationInstantiation), which happens BEFORE its first statement
// executes. So each script is compiled with `throw PROBE;` as its first
// statement and run into one node:vm context per page, in execution order.
// V8 creates the script's global bindings, then throws the probe; a clash
// surfaces as V8's own "has already been declared" SyntaxError, exactly as in
// a browser. No page code runs, so jQuery, main.js and the apps' DOM wiring
// need no stub environment, and a stub can never be what makes this pass.
// The probe goes after a leading 'use strict' directive, because moving the
// directive would change which names a sloppy-mode block function hoists.
//
// Measured on node 20 before relying on it: const/const, let/let, class/const,
// var-then-let, let-then-var, function-then-const and const-then-function all
// throw; var/var, function/function and a `const` inside an IIFE do not.
//
// WHAT COUNTS
//   - pages: every published .html page (scripts/build-publish-dir.mjs is the
//     allow-list), not a hand-kept app list, so a new page is covered by
//     existing. The generated trees (apps/rising-shows/shows/,
//     apps/gym-tracker/exercises/) are gitignored build output and absent in
//     CI; their templates load only analytics.js and back-to-top.js, which
//     committed pages load together, plus one inline IIFE.
//   - scripts: same-origin `<script src>` and inline `<script>` blocks whose
//     type is empty or a JavaScript MIME type. Modules, JSON-LD, `nomodule`,
//     and anything inside a comment, <template> or <noscript> are skipped,
//     because none of them runs in the shared scope. Cross-origin scripts
//     (gtag.js) cannot be read and are skipped.
//   - order: parser-inserted scripts (plain, async, inline) in document order,
//     then `defer` scripts in document order. A clash exists in either order;
//     the order only decides which of the two files the browser kills.
//   - host globals: `window`, `document`, `location` and `top` are
//     non-configurable on a real window, so `let top` is a SyntaxError there
//     too; they are defined the same way here.
//
// If this fails: rename one of the two names, or give the file its own scope
// (an IIFE, as providers-lib.js does, or type="module", as the Rising Shows
// app.js and integrations-lib.js on index.html do). Never reorder scripts to
// make it pass.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve, dirname, posix } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { publishedFiles } from '../../scripts/build-publish-dir.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GENERATED = /^apps\/(rising-shows\/shows|gym-tracker\/exercises)\//;
const PROBE = '__shevato_shared_scope_probe__';
const JS_TYPES = new Set([
  'text/javascript', 'application/javascript', 'application/ecmascript', 'text/ecmascript',
  'application/x-javascript', 'text/x-javascript', 'text/jscript',
]);
const HOST_UNFORGEABLE = ['window', 'document', 'location', 'top'];

/** Attribute value by name, or null. Names are matched as whole attributes, so `data-src` is not `src`. */
function attr(attrs, name) {
  const m = new RegExp(`(?:^|\\s)${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, 'i').exec(attrs);
  return m ? (m[1] ?? m[2] ?? m[3]) : null;
}
/** Boolean attribute present (quoted values blanked first, so `src="defer.js"` is not `defer`). */
function flag(attrs, name) {
  return new RegExp(`(?:^|\\s)${name}(?=\\s|=|$)`, 'i').test(attrs.replace(/"[^"]*"|'[^']*'/g, '""'));
}

/**
 * The scripts of one page that share the global lexical scope, in the order a
 * browser executes them. Each is { name, file } for a same-origin src or
 * { name, code } for an inline block.
 */
export function classicScriptsOf(pagePath, html) {
  const markup = html
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<template\b[\s\S]*?<\/template\s*>/gi, '')
    .replace(/<noscript\b[\s\S]*?<\/noscript\s*>/gi, '');
  const parserInserted = [];
  const deferred = [];
  let inline = 0;
  for (const m of markup.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const attrs = m[1];
    const type = (attr(attrs, 'type') || '').trim().toLowerCase();
    if (type && !JS_TYPES.has(type)) continue;
    if (flag(attrs, 'nomodule')) continue;
    const src = attr(attrs, 'src');
    if (src === null) {
      inline++;
      parserInserted.push({ name: `${pagePath} (inline script ${inline})`, code: m[2] });
      continue;
    }
    if (/^([a-z][a-z0-9+.-]*:|\/\/)/i.test(src)) continue;
    const clean = src.split('#')[0].split('?')[0];
    const rel = clean.startsWith('/')
      ? clean.slice(1)
      : posix.normalize(posix.join(posix.dirname(pagePath), clean));
    (flag(attrs, 'defer') ? deferred : parserInserted).push({ name: rel, file: rel });
  }
  return [...parserInserted, ...deferred];
}

function browserLikeContext() {
  const ctx = vm.createContext({});
  vm.runInContext(
    HOST_UNFORGEABLE
      .map((n) => `Object.defineProperty(globalThis, ${JSON.stringify(n)}, { value: globalThis, configurable: false, writable: false, enumerable: true });`)
      .join('\n'),
    ctx,
  );
  return ctx;
}

/** The source with `throw PROBE;` as its first statement, after any leading 'use strict' directive. */
function withProbe(code) {
  const lead = /^(?:\s+|\/\/[^\n]*|\/\*[\s\S]*?\*\/)*/.exec(code)[0].length;
  const directive = /^(['"])use strict\1/.exec(code.slice(lead));
  const at = directive ? lead + directive[0].length : 0;
  return `${code.slice(0, at)};throw ${JSON.stringify(PROBE)};${code.slice(at)}`;
}

/** Instantiate one script in ctx without executing it. Returns null, or the error the browser would raise. */
function instantiate(ctx, script) {
  try {
    new vm.Script(withProbe(script.code), { filename: script.name }).runInContext(ctx);
  } catch (err) {
    return err === PROBE ? null : err;
  }
  return new Error(`${script.name} ran past the scope probe`);
}

/** Which of `accepted` first declared `identifier`: the shortest prefix after which `let identifier` clashes. */
function firstDeclarer(accepted, identifier) {
  const clashesAfter = (n) => {
    const ctx = browserLikeContext();
    for (let i = 0; i < n; i++) instantiate(ctx, accepted[i]);
    return instantiate(ctx, { name: 'probe', code: `let ${identifier};` }) !== null;
  };
  if (!clashesAfter(accepted.length)) return null;
  let lo = 0;
  let hi = accepted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (clashesAfter(mid)) hi = mid; else lo = mid + 1;
  }
  return lo === 0 ? null : accepted[lo - 1].name;
}

/**
 * Run scripts ({ name, code }) into one shared scope in order.
 * collisions: [{ identifier, file, declaredBy }] where `file` is the script the
 * browser refuses and `declaredBy` the earlier one holding the name (null for a
 * host global). errors: any other failure to instantiate, e.g. a syntax error.
 */
export function findScopeCollisions(scripts) {
  const ctx = browserLikeContext();
  const accepted = [];
  const collisions = [];
  const errors = [];
  for (const script of scripts) {
    const err = instantiate(ctx, script);
    if (!err) { accepted.push(script); continue; }
    const clash = /Identifier '([^']+)' has already been declared/.exec(String(err && err.message));
    if (clash) {
      collisions.push({ identifier: clash[1], file: script.name, declaredBy: firstDeclarer(accepted, clash[1]) });
    } else {
      errors.push({ file: script.name, message: `${err && err.name}: ${err && err.message}` });
    }
  }
  return { collisions, errors };
}

function describe({ identifier, file, declaredBy }) {
  return `'${identifier}' is declared by ${declaredBy || 'the browser window itself (a non-configurable global)'}`
    + ` and again by ${file}; the browser refuses ${file} with "SyntaxError: Identifier '${identifier}' has already been declared"`;
}

// --- the checker itself ------------------------------------------------------

test('the checker reports a top-level const declared by two scripts, naming both files and the name', () => {
  const { collisions, errors } = findScopeCollisions([
    { name: 'scripts/finder-lib.js', code: "'use strict';\nconst API = {};\nwindow.RisingShowsFinder = API;" },
    { name: 'scripts/providers-lib.js', code: "const OTHER = 1;" },
    { name: 'scripts/match.js', code: "'use strict';\nconst API = { detectShapes() {} };" },
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(collisions, [{ identifier: 'API', file: 'scripts/match.js', declaredBy: 'scripts/finder-lib.js' }]);
});

test('the checker sees every clash a browser refuses, and none it accepts', () => {
  const clash = (a, b) => findScopeCollisions([{ name: 'a.js', code: a }, { name: 'b.js', code: b }]).collisions.length;
  for (const [a, b] of [
    ['let X;', 'let X;'], ['class X {}', 'const X = 1;'], ['var X;', 'let X;'], ['let X;', 'var X;'],
    ['function X() {}', 'const X = 1;'], ['const X = 1;', 'function X() {}'],
  ]) {
    assert.equal(clash(a, b), 1, `${a} then ${b} must be reported`);
  }
  for (const [a, b] of [
    ['var X;', 'var X;'], ['function X() {}', 'function X() {}'],
    ['const X = 1;', '(function () { const X = 2; })();'], ['const X = 1;', 'window.X = 2;'],
  ]) {
    assert.equal(clash(a, b), 0, `${a} then ${b} is legal in a browser`);
  }
  // Nothing executes: a script that would throw, loop or touch the DOM at load
  // is still only declared.
  assert.deepEqual(findScopeCollisions([{ name: 'a.js', code: 'while (true) {} document.body.x();' }]).errors, []);
});

test('the checker treats the window\'s non-configurable globals as taken', () => {
  const { collisions } = findScopeCollisions([{ name: 'nav.js', code: 'const top = 0;' }]);
  assert.deepEqual(collisions, [{ identifier: 'top', file: 'nav.js', declaredBy: null }]);
});

test('the probe keeps a leading "use strict" in charge of the file', () => {
  // In sloppy mode a block-level function also creates a global var, which
  // would clash with the second script's `let f`; in strict mode it does not.
  const scripts = [
    { name: 'strict.js', code: "/* header */\n'use strict';\n{ function f() {} }" },
    { name: 'b.js', code: 'let f;' },
  ];
  assert.deepEqual(findScopeCollisions(scripts).collisions, []);
});

test('script extraction follows what a browser actually runs, in the order it runs it', () => {
  const html = `
    <script src="../../assets/js/jquery.min.js"></script>
    <!-- <script src="scripts/commented-out.js"></script> -->
    <script type="application/ld+json">{"@type":"Thing"}</script>
    <script type="module" src="js/app.js"></script>
    <script src="scripts/match.js" defer></script>
    <script async src="https://www.googletagmanager.com/gtag/js?id=G"></script>
    <script>window.CONFIG = 1;</script>
    <template><script src="scripts/in-template.js"></script></template>
    <script type="text/javascript" src="/assets/js/main.js?v=2"></script>
    <script data-src="x.js" src="scripts/defer-in-name.js"></script>`;
  assert.deepEqual(
    classicScriptsOf('apps/rising-shows/index.html', html).map((s) => s.name),
    [
      'assets/js/jquery.min.js',
      'apps/rising-shows/index.html (inline script 1)',
      'assets/js/main.js',
      'apps/rising-shows/scripts/defer-in-name.js',
      'apps/rising-shows/scripts/match.js',
    ],
  );
});

// --- every published page --------------------------------------------------

const PAGES = (await publishedFiles())
  .filter((f) => f.endsWith('.html') && !GENERATED.test(f))
  .sort()
  .map((page) => {
    const scripts = classicScriptsOf(page, readFileSync(join(REPO_ROOT, page), 'utf8'));
    return { page, scripts };
  });

test('the inventory reaches the pages with the most classic scripts, so this guard has a premise', () => {
  const count = (page) => (PAGES.find((p) => p.page === page) || { scripts: [] }).scripts.length;
  // Floors, not exact counts: these pages were unguarded until this file, and
  // an inventory that silently stopped reaching them would pass for nothing.
  for (const [page, atLeast] of [
    ['apps/rising-shows/index.html', 10],
    ['apps/rising-shows/kometa/index.html', 10],
    ['apps/mario-kart/index.html', 40],
    ['apps/football-h2h/index.html', 20],
  ]) {
    assert.ok(count(page) >= atLeast, `${page}: expected at least ${atLeast} classic scripts in the shared scope, found ${count(page)}`);
  }
  assert.ok(PAGES.filter((p) => p.scripts.length >= 2).length >= 15, 'the published-page inventory shrank unexpectedly');
});

for (const { page, scripts } of PAGES.filter((p) => p.scripts.length >= 2)) {
  test(`${page}: its ${scripts.length} classic scripts can share one global scope`, () => {
    const missing = scripts.filter((s) => s.file && !existsSync(join(REPO_ROOT, s.file)));
    assert.deepEqual(missing.map((s) => s.file), [], `${page} loads classic scripts that do not exist`);
    const loaded = scripts.map((s) => (s.file ? { name: s.name, code: readFileSync(join(REPO_ROOT, s.file), 'utf8') } : s));
    const { collisions, errors } = findScopeCollisions(loaded);
    assert.deepEqual(
      collisions.map(describe), [],
      `${page}: a top-level name is declared twice in the page's shared scope. Rename one, or give the file its own scope (an IIFE or type="module").`,
    );
    assert.deepEqual(errors.map((e) => `${e.file}: ${e.message}`), [], `${page}: a classic script failed to instantiate`);
  });
}
