// Shared source-extraction helpers for the gym-tracker test estate.
//
// Most view logic hangs off DOM-bound classes that cannot be imported under
// node, and several helpers are module-private. Instead of hand-copying that
// logic into tests (a mirror silently drifts from the real code - it happened:
// the collapse-state mirror missed the #23 re-arm change), these helpers lift
// the REAL method/function source text out of the file and evaluate it against
// stubs. If the production code changes shape or behavior, the extraction or
// the assertions fail loudly.
//
// This file deliberately does not match node's test-file glob (*.test.mjs),
// so `node --test apps/gym-tracker/tests/` never runs it directly.

import { readFileSync } from 'node:fs';

/** Read a production source file relative to the app root (gym-tracker/). */
export function loadSource(relPath) {
    return readFileSync(new URL(`../../${relPath}`, import.meta.url), 'utf8');
}

/**
 * Extract one class method's source text. Class methods sit at 4-space
 * indentation ("\n    name("), which call sites never do (they carry a
 * "this." or deeper indentation), so the marker is unambiguous.
 * The returned text is object-literal-shorthand compatible.
 */
export function extractClassMethod(src, name, file = 'source') {
    return extractAt(src, `\n    ${name}(`, `${name}()`, file);
}

/** Extract a module-level `function name(...) { ... }` declaration. */
export function extractFunction(src, name, file = 'source') {
    return extractAt(src, `\nfunction ${name}(`, `function ${name}()`, file);
}

function extractAt(src, marker, label, file) {
    const start = src.indexOf(marker);
    if (start === -1) throw new Error(`${label} not found in ${file}`);
    // Skip past the parameter list first (default params may contain {}),
    // then brace-match the body. Template-literal ${} stays balanced, so the
    // naive counter holds for this codebase's methods.
    let i = src.indexOf('(', start);
    let parens = 0;
    for (; i < src.length; i++) {
        if (src[i] === '(') parens++;
        else if (src[i] === ')' && --parens === 0) break;
    }
    let depth = 0;
    i = src.indexOf('{', i);
    for (; i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) break;
    }
    return src.slice(start + 1, i + 1).trim();
}

/**
 * Evaluate a set of extracted class methods as one object, with the given
 * dependencies (document stubs, imported helpers the methods reference)
 * shadowed as parameters. Returns the bare object; callers typically use it
 * as the prototype of a view stub carrying instance state.
 */
export function buildMethods(src, names, deps = {}, file = 'source') {
    const body = names.map((n) => extractClassMethod(src, n, file)).join(',\n');
    const depNames = Object.keys(deps);
    const factory = new Function(...depNames, `"use strict"; return { ${body} };`);
    return factory(...depNames.map((k) => deps[k]));
}

/** Same idea for module-level functions: returns { name: fn, ... }. */
export function buildFunctions(src, names, deps = {}, file = 'source') {
    const decls = names.map((n) => extractFunction(src, n, file)).join('\n');
    const depNames = Object.keys(deps);
    const factory = new Function(
        ...depNames,
        `"use strict"; ${decls}\nreturn { ${names.join(', ')} };`
    );
    return factory(...depNames.map((k) => deps[k]));
}
