// Stored-XSS guard for the Achievements category headers (audit G-1, 2026-09-12).
//
// The category view groups achievements by `requirement.type` and used to
// interpolate that key RAW into four sinks: `data-category-key`, `aria-controls`,
// the chain `id`, and the `<h2>` built from the humanized key. An imported
// backup (and, because `gymTrackerAchievements` is synced, every device on the
// account) could therefore carry `x" onmouseover="alert(1)` into a live
// attribute of a <button>, or `<img src=x onerror=...>` into the heading.
//
// The import sanitiser now refuses such records, but storage that was already
// synced is not re-sanitised, so the view has to be safe on its own. These
// tests run the REAL `render()` (source-extracted, never mirrored) against a
// hostile record and inspect the markup with an attribute-aware tag scanner:
// no injected attribute, no injected element, and the literal text still shows
// as text where the heading shows it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractClassMethod, loadSource } from './helpers/source-extract.mjs';
import { Achievement } from '../js/models/Achievement.js';
import { AchievementService } from '../js/services/AchievementService.js';
import { escapeHtml, formatDate } from '../js/utils/helpers.js';
import { displayWeight, normalizeWeightUnit, volumeIn } from '../js/utils/units.js';

const FILE = 'js/views/achievements-view.js';
const src = loadSource(FILE);

const ATTRIBUTE_BREAKER = 'x" onmouseover="alert(1)';
const ELEMENT_INJECTOR = '<img src=x onerror=alert(1)>';

/**
 * Build a view object from the real render path. The module prelude (the
 * constants and helpers between the imports and the class) is evaluated in the
 * same scope as the extracted methods, so whatever module-level helper the
 * render code uses is the real one.
 */
function buildView({ achievements, expanded = [] }) {
    const preludeStart = src.lastIndexOf('\nimport ');
    const prelude = src.slice(src.indexOf('\n', preludeStart + 1), src.indexOf('\nclass AchievementsView'));
    const names = ['render', 'renderPRSection', 'prAchievements', 'renderCard', 'matchesFilter',
        'updateBulkToggleState', 'localizeUnit', 'weightUnit'];
    const body = names.map((n) => extractClassMethod(src, n, FILE)).join(',\n');

    const els = {
        'achievements-list': { innerHTML: '' },
        'unlocked-count': { textContent: '' },
        'total-achievements': { textContent: '' },
    };
    const document = { getElementById: (id) => els[id] || null };
    const deps = { document, Achievement, AchievementService, escapeHtml, formatDate, displayWeight, normalizeWeightUnit, volumeIn };
    const factory = new Function(...Object.keys(deps), `"use strict";\n${prelude}\nreturn { ${body} };`);
    const view = Object.create(factory(...Object.values(deps)));
    Object.assign(view, {
        app: { achievements, workoutSessions: [], settings: { weightUnit: 'kg' } },
        statusFilter: 'all',
        sortMode: 'category',
        expandedCategories: new Set(expanded),
    });
    return { view, container: els['achievements-list'] };
}

/** The humanizer the heading uses, lifted from the same source. */
function humanize(key) {
    const fnSrc = src.slice(src.indexOf('function humanizeCategoryKey'), src.indexOf('\n}\n', src.indexOf('function humanizeCategoryKey')) + 2);
    return new Function(`"use strict"; ${fnSrc}; return humanizeCategoryKey;`)()(key);
}

const decode = (s) => s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&amp;/g, '&');

/**
 * Tokenise markup the way an HTML parser splits tags and attributes: quoted
 * values end only at their own quote, so a `"` smuggled into a value is exactly
 * what starts a new attribute here, as it would in a browser.
 */
function scanTags(html) {
    const tags = [];
    let i = 0;
    while ((i = html.indexOf('<', i)) !== -1) {
        const m = /^<(\/?)([a-zA-Z][\w-]*)/.exec(html.slice(i));
        if (!m) { i++; continue; }
        let j = i + m[0].length;
        const attrs = [];
        while (j < html.length) {
            while (/\s/.test(html[j])) j++;
            if (html[j] === '>') { j++; break; }
            if (html[j] === '/') { j++; continue; }
            const nm = /^[^\s"'>/=]+/.exec(html.slice(j));
            if (!nm) { j++; continue; }
            const name = nm[0].toLowerCase();
            j += nm[0].length;
            while (/\s/.test(html[j])) j++;
            let value = null;
            if (html[j] === '=') {
                j++;
                while (/\s/.test(html[j])) j++;
                const q = html[j];
                if (q === '"' || q === "'") {
                    const end = html.indexOf(q, j + 1);
                    value = html.slice(j + 1, end);
                    j = end + 1;
                } else {
                    value = /^[^\s>]*/.exec(html.slice(j))[0];
                    j += value.length;
                }
            }
            attrs.push({ name, value });
        }
        tags.push({ name: m[2].toLowerCase(), close: m[1] === '/', attrs, start: i, end: j });
        i = j;
    }
    return tags;
}

const hostileAchievement = (type) => Achievement.fromJSON({
    id: 'shared-badge', name: 'Badge', description: 'Imported', type: 'global',
    unlocked: true, requirement: { type, target: 1 }, target: 1,
});
const knownAchievement = () => Achievement.fromJSON(
    AchievementService.getDefaultAchievements().find((a) => a.requirement.type === 'total-workouts').toJSON());

for (const hostile of [ATTRIBUTE_BREAKER, ELEMENT_INJECTOR]) {
    for (const expanded of [false, true]) {
        test(`a hostile requirement type ${JSON.stringify(hostile)} injects nothing into the category header (${expanded ? 'expanded' : 'collapsed'})`, () => {
            const { view, container } = buildView({
                achievements: [knownAchievement(), hostileAchievement(hostile)],
                expanded: expanded ? [hostile] : [],
            });
            view.render();
            const tags = scanTags(container.innerHTML);

            const allowedTags = new Set(['section', 'button', 'span', 'div', 'h2', 'h3', 'p', 'strong', 'i', 'small']);
            const foreign = tags.filter((t) => !allowedTags.has(t.name)).map((t) => t.name);
            assert.deepEqual(foreign, [], 'no element outside the template was injected');

            const handlers = tags.flatMap((t) => t.attrs).filter((a) => a.name.startsWith('on'));
            assert.deepEqual(handlers, [], 'no event-handler attribute exists anywhere in the markup');

            const headers = tags.filter((t) => t.name === 'button' && !t.close);
            assert.equal(headers.length, 2, 'one header per category');
            for (const h of headers) {
                assert.deepEqual(h.attrs.map((a) => a.name),
                    ['type', 'class', 'data-category-key', 'aria-expanded', 'aria-controls'],
                    'the header carries exactly its template attributes');
            }

            const header = headers.find((h) => decode(h.attrs.find((a) => a.name === 'data-category-key').value) === hostile);
            assert.ok(header, 'the click handler still reads the real key back from data-category-key');

            const controls = header.attrs.find((a) => a.name === 'aria-controls').value;
            assert.match(controls, /^achievement-chain-[a-z0-9_-]+$/, 'the id reference is a safe slug');
            const chain = tags.find((t) => t.name === 'div' && t.attrs.some((a) => a.name === 'id' && a.value === controls));
            assert.ok(chain, 'aria-controls still points at the chain it controls');
            assert.deepEqual(chain.attrs.map((a) => a.name).filter((n) => n !== 'hidden'), ['class', 'id']);
            assert.equal(chain.attrs.some((a) => a.name === 'hidden'), !expanded);

            // The heading shows the humanized key as TEXT: the escaped markup
            // decodes back to exactly what the humanizer produced.
            const html = container.innerHTML;
            const section = html.slice(header.start, html.indexOf('</button>', header.start));
            const h2 = /<h2>([\s\S]*?)<\/h2>/.exec(section);
            assert.ok(h2, 'the heading is rendered');
            assert.equal(decode(h2[1]), humanize(hostile));
        });
    }
}

test('a known category keeps its readable id, so existing selectors and aria wiring are unchanged', () => {
    const { view, container } = buildView({ achievements: [knownAchievement()], expanded: ['total-workouts'] });
    view.render();
    assert.match(container.innerHTML, /data-category-key="total-workouts"/);
    assert.match(container.innerHTML, /aria-controls="achievement-chain-total-workouts"/);
    assert.match(container.innerHTML, /id="achievement-chain-total-workouts"/);
    assert.match(container.innerHTML, /<h2>Total Workouts<\/h2>/);
});

test('a prototype-key type is not mistaken for a known category', () => {
    // CATEGORY_META['constructor'] is Object's constructor through the
    // prototype chain; a lookup that follows it renders "Object" with an
    // undefined icon instead of the readable fallback.
    const { view, container } = buildView({ achievements: [hostileAchievement('constructor')], expanded: [] });
    view.render();
    assert.match(container.innerHTML, /<h2>Constructor<\/h2>/);
    assert.doesNotMatch(container.innerHTML, /undefined/);
});
