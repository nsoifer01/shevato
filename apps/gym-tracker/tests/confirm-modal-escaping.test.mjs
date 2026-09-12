/**
 * `showConfirmModal({ message })` is an innerHTML sink, enforced at the source.
 *
 * `js/utils/helpers.js` renders the message with
 * `messageEl.innerHTML = message.replace(/\n/g, '<br>')`, deliberately: every
 * confirm message in the app carries `<strong>` emphasis and `<br>` breaks.
 * The price is that ANY user-authored text interpolated into that template is
 * markup. Exercise names, program names and workout names are user-authored,
 * they survive an export/import round trip (`js/utils/import-sanitize.js`
 * only checks that a custom exercise name is a non-empty string), and they
 * are therefore attacker-controlled in the "shared backup file" sense.
 *
 * The real defect this pins: the in-workout swap confirmation interpolated
 * `replacement.name` raw, while nine sibling confirmations escaped. One
 * unescaped site is all it takes, so the rule is checked on the SHAPE rather
 * than per-screen.
 *
 * THE RULE (narrow on purpose): inside a template literal that becomes a
 * `showConfirmModal` message, any interpolation that reads a NAME-LIKE
 * property (`.name`, `.exerciseName`, `.workoutDayName`, `.programName`,
 * `.title`, `.label`, `.notes`) must pass through `escapeHtml()`.
 * Counts, dates and formatter calls are not user text and are not checked;
 * a bare `${name}` identifier is not checked either, because this codebase
 * escapes those at assignment (`const name = escapeHtml(...)`).
 */
process.env.TZ = 'UTC';

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildMethods, loadSource } from './helpers/source-extract.mjs';
import { sameId } from '../js/utils/id-utils.js';
import { escapeHtml } from '../js/utils/helpers.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const VIEWS = join(HERE, '..', 'js', 'views');
const viewFiles = readdirSync(VIEWS).filter((f) => f.endsWith('.js'));

// ---------------------------------------------------------------------------
// A very small source walker. It exists so the scan reads real syntax instead
// of a regex: `message:` values are template literals that contain `${}` with
// nested quotes, and concatenations that span several lines.
// ---------------------------------------------------------------------------

/** Index of the closing quote of the string that starts at `i`. */
function skipQuoted(src, i) {
    const quote = src[i];
    for (let j = i + 1; j < src.length; j++) {
        if (src[j] === '\\') { j++; continue; }
        if (src[j] === quote || src[j] === '\n') return j;
    }
    return src.length;
}

/** Index of the closing backtick of the template literal that starts at `i`. */
function skipTemplate(src, i) {
    let j = i + 1;
    while (j < src.length) {
        const ch = src[j];
        if (ch === '\\') { j += 2; continue; }
        if (ch === '`') return j;
        if (ch === '$' && src[j + 1] === '{') {
            let depth = 1;
            j += 2;
            while (j < src.length && depth > 0) {
                const c = src[j];
                if (c === '\\') { j += 2; continue; }
                if (c === '`') { j = skipTemplate(src, j) + 1; continue; }
                if (c === '"' || c === "'") { j = skipQuoted(src, j) + 1; continue; }
                if (c === '{') depth++;
                else if (c === '}') depth--;
                j++;
            }
            continue;
        }
        j++;
    }
    return src.length;
}

/**
 * Walk forward from `start`, skipping comments, strings and template literals,
 * reporting every template literal body to `onTemplate`. Stops at the first
 * character in `stops`, or at a closing bracket, that sits at nesting depth 0
 * relative to `start`. Returns that index.
 */
function walk(src, start, stops, onTemplate) {
    let i = start;
    let depth = 0;
    while (i < src.length) {
        const ch = src[i];
        if (ch === '/' && src[i + 1] === '/') {
            const nl = src.indexOf('\n', i);
            if (nl === -1) return src.length;
            i = nl + 1;
            continue;
        }
        if (ch === '/' && src[i + 1] === '*') {
            const end = src.indexOf('*/', i);
            i = end === -1 ? src.length : end + 2;
            continue;
        }
        if (ch === '"' || ch === "'") { i = skipQuoted(src, i) + 1; continue; }
        if (ch === '`') {
            const end = skipTemplate(src, i);
            if (onTemplate) onTemplate(src.slice(i + 1, end), i);
            i = end + 1;
            continue;
        }
        if (ch === '(' || ch === '[' || ch === '{') { depth++; i++; continue; }
        if (ch === ')' || ch === ']' || ch === '}') {
            if (depth === 0) return i;
            depth--;
            i++;
            continue;
        }
        if (depth === 0 && stops.includes(ch)) return i;
        i++;
    }
    return src.length;
}

/**
 * The `${...}` expressions of one template-literal body. Substitutions that
 * themselves contain a nested template are returned whole; this codebase has
 * none inside a confirm message, and returning the whole text still exposes
 * any name-like read inside it to the rule below.
 */
function interpolations(raw) {
    const out = [];
    let i = 0;
    while (i < raw.length) {
        if (raw[i] === '\\') { i += 2; continue; }
        if (raw[i] === '$' && raw[i + 1] === '{') {
            let depth = 1;
            let j = i + 2;
            const start = j;
            while (j < raw.length && depth > 0) {
                const ch = raw[j];
                if (ch === '\\') { j += 2; continue; }
                if (ch === '`') { j = skipTemplate(raw, j) + 1; continue; }
                if (ch === '"' || ch === "'") { j = skipQuoted(raw, j) + 1; continue; }
                if (ch === '{') depth++;
                else if (ch === '}') { depth--; if (depth === 0) break; }
                j++;
            }
            out.push(raw.slice(start, j));
            i = j + 1;
            continue;
        }
        i++;
    }
    return out;
}

/** Matching close bracket for the opener at `open`. */
function matchBracket(src, open) {
    const end = walk(src, open + 1, [], null);
    return end;
}

/**
 * Every template literal that reaches a `showConfirmModal` message, with the
 * line it starts on. A `message: someLocal` value is resolved by finding that
 * local's `const <name> = ` declaration in the same file, which is how the
 * four longest messages in the app are written.
 */
function confirmMessageTemplates(src, file) {
    const found = [];
    const lineOf = (idx) => src.slice(0, idx).split('\n').length;

    for (const call of src.matchAll(/showConfirmModal\s*\(/g)) {
        const open = call.index + call[0].length - 1;
        const close = matchBracket(src, open);
        const span = src.slice(open, close);
        const key = /(?:[{,]\s*)message\s*:/.exec(span);
        if (!key) continue;
        const valueStart = open + key.index + key[0].length;

        let sawTemplate = false;
        walk(src, valueStart, [','], (raw, at) => {
            sawTemplate = true;
            found.push({ raw, line: lineOf(at), file });
        });
        if (sawTemplate) continue;

        // `message: message` - follow the local back to its declaration.
        const ident = /^\s*([A-Za-z_$][\w$]*)\s*(?:,|\n\s*\})/.exec(src.slice(valueStart, valueStart + 80));
        if (!ident) continue;
        const decl = new RegExp(String.raw`\b(?:const|let|var)\s+${ident[1]}\s*=`).exec(src);
        if (!decl) continue;
        walk(src, decl.index + decl[0].length, [';'], (raw, at) => {
            found.push({ raw, line: lineOf(at), file });
        });
    }
    return found;
}

/** User-authored text in this app's data model. Everything else is a number. */
const NAME_LIKE = /\.\s*(exerciseName|workoutDayName|programName|name|title|label|notes)\b/;

test('the confirm-message scan actually finds the app\'s confirmations', () => {
    // A scanner that silently matches nothing is a test that can never fail.
    const all = viewFiles.flatMap((f) =>
        confirmMessageTemplates(readFileSync(join(VIEWS, f), 'utf8'), f));
    assert.ok(all.length >= 9,
        `expected the app's confirm messages to be scanned, found ${all.length}`);
    assert.ok(all.some((t) => t.raw.includes('escapeHtml')),
        'and at least one of them escapes, so the escaping is visible to the scan');
});

for (const file of viewFiles) {
    test(`${file} escapes every name it puts in a confirm message`, () => {
        const src = readFileSync(join(VIEWS, file), 'utf8');
        const offenders = [];
        for (const tpl of confirmMessageTemplates(src, file)) {
            for (const expr of interpolations(tpl.raw)) {
                if (!NAME_LIKE.test(expr)) continue;
                if (expr.includes('escapeHtml(')) continue;
                offenders.push(`${file}:${tpl.line} \${${expr.trim()}}`);
            }
        }
        assert.deepEqual(offenders, [],
            'showConfirmModal renders its message with innerHTML, so a name '
            + 'interpolated raw is markup. Wrap it in escapeHtml() the way '
            + `exercises-view.js does:\n  ${offenders.join('\n  ')}`);
    });
}

// ---------------------------------------------------------------------------
// The direct regression: the swap confirmation, run for real.
// ---------------------------------------------------------------------------

const workoutSrc = loadSource('js/views/workout-view.js');
const HOSTILE = '<img src=x onerror="alert(1)">';

function swapView(replacementName) {
    const seen = {};
    const methods = buildMethods(workoutSrc, ['pickSwapExercise'], {
        sameId,
        escapeHtml,
        showConfirmModal: async (opts) => { seen.confirm = opts; return true; },
        showToast: (text) => { seen.toast = text; },
        document: { getElementById: () => ({ classList: { remove() {} } }) },
    }, 'workout-view.js');

    const view = Object.create(methods);
    view.swapTargetIndex = 0;
    view.currentWorkoutSession = {
        exercises: [{ exerciseId: 1, exerciseName: 'Bench Press', sets: [{ completed: true }], stickyValues: { 0: 60 } }],
    };
    view.app = { exerciseDatabase: [{ id: 2, name: replacementName }] };
    view.warmupExpanded = {};
    view.warmupDone = {};
    view.rebuildSessionPrSlots = () => {};
    view.persistActiveWorkout = () => {};
    view.renderActiveWorkout = () => {};
    return { view, seen };
}

test('a hostile exercise name cannot inject markup through the swap confirmation', async () => {
    const { view, seen } = swapView(HOSTILE);
    await view.pickSwapExercise(2);

    assert.ok(seen.confirm, 'the swap confirmation was shown (there is a logged set)');
    assert.ok(!seen.confirm.message.includes('<img'),
        `raw markup reached the innerHTML sink: ${seen.confirm.message}`);
    assert.ok(seen.confirm.message.includes('&lt;img'),
        'the name must arrive HTML-escaped');
});

test('an ordinary exercise name still reads naturally in the confirmation', async () => {
    const { view, seen } = swapView('Incline Dumbbell Press');
    await view.pickSwapExercise(2);
    assert.match(seen.confirm.message, /1 logged set will move under Incline Dumbbell Press\./);
});
