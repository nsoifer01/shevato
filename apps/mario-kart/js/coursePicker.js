// Course picker UI for the sidebar race form.
//
// An optional "which course did we play?" selector above the position inputs.
// Designed to be fast: quick-tap chips for recent + favorite courses, a ranked
// type-ahead search (fuzzy on name / alias / initials / origin), full keyboard
// navigation, and a cup-grouped browse list. Selection is read back by
// dataManager.addRace() via window.CoursePicker.getSelected().
//
// Classic-script module. Data + ranking live in courseData.js; this file is
// presentation + interaction only, so it stays out of the vm unit tests.

(function () {
    'use strict';

    const esc = (s) => (window.escapeHtml ? window.escapeHtml(String(s)) : String(s));

    let state = {
        courses: [],      // flattened, cup-annotated
        cups: [],         // grouped (browse order)
        byId: {},         // id -> course
        selectedId: null,
        selectedName: null,
        open: false,
        query: '',
        options: [],      // ids in current keyboard-navigable order
        active: -1        // index into options, -1 = none
    };

    let outsideHandler = null;

    function container() { return document.getElementById('sidebar-course-picker'); }
    function panelEl() { const c = container(); return c && c.querySelector('.course-picker-panel'); }
    function searchEl() { const c = container(); return c && c.querySelector('.course-picker-search'); }
    function resultsEl() { const c = container(); return c && c.querySelector('.cp-results'); }

    // ---- Public API ----------------------------------------------------------
    function getSelected() {
        return state.selectedId ? { id: state.selectedId, name: state.selectedName } : null;
    }

    function setSelected(course) {
        state.selectedId = course ? course.id : null;
        state.selectedName = course ? course.name : null;
        closePanel();
        renderTrigger();
    }

    function clear() { setSelected(null); }

    function commit() {
        if (state.selectedId) window.CourseData.pushRecent(state.selectedId);
    }

    // ---- Rendering -----------------------------------------------------------
    function renderTrigger() {
        const c = container();
        if (!c) return;
        const label = c.querySelector('.cp-label');
        const clearBtn = c.querySelector('.cp-clear');
        const trigger = c.querySelector('.course-picker-trigger');
        if (label) {
            label.textContent = state.selectedName || 'Select course (optional)';
            label.classList.toggle('cp-placeholder', !state.selectedName);
        }
        if (clearBtn) clearBtn.hidden = !state.selectedId;
        if (trigger) trigger.setAttribute('aria-expanded', state.open ? 'true' : 'false');
    }

    // Highlight the matched run of the query within a course name.
    function highlight(name, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return esc(name);
        const i = name.toLowerCase().indexOf(q);
        if (i === -1) return esc(name);
        return esc(name.slice(0, i)) +
            '<mark class="cp-hl">' + esc(name.slice(i, i + q.length)) + '</mark>' +
            esc(name.slice(i + q.length));
    }

    function originPill(course) {
        if (!course.origin) return '';
        if (course.origin === 'new') return '<span class="cp-pill cp-pill-new">New</span>';
        return '<span class="cp-pill cp-pill-retro">' + esc(course.origin) + '</span>';
    }

    // A full browse/search row. `idx` is the keyboard index (or -1 for none).
    function rowHtml(course, idx) {
        const fav = window.CourseData.isFavorite(course.id);
        const cups = (course.cups && course.cups.length) ? esc(course.cups.join(' / ')) : '';
        return (
            '<div class="cp-row' + (course.id === state.selectedId ? ' cp-selected' : '') +
                (idx === state.active ? ' cp-active' : '') + '" role="option" id="cp-opt-' + idx +
                '" aria-selected="' + (course.id === state.selectedId ? 'true' : 'false') + '">' +
                '<button type="button" class="cp-course" data-id="' + esc(course.id) + '" data-idx="' + idx + '" tabindex="-1">' +
                    '<span class="cp-name">' + highlight(course.name, state.query) +
                        (course.id === state.selectedId ? '<span class="cp-check">✓</span>' : '') + '</span>' +
                    '<span class="cp-meta">' + (cups ? '<span class="cp-cup">' + cups + '</span>' : '') + originPill(course) + '</span>' +
                '</button>' +
                '<button type="button" class="cp-fav' + (fav ? ' is-fav' : '') + '" data-fav="' + esc(course.id) +
                    '" tabindex="-1" title="' + (fav ? 'Remove favorite' : 'Add favorite') +
                    '" aria-label="Toggle favorite">' + (fav ? '★' : '☆') + '</button>' +
            '</div>'
        );
    }

    function chipHtml(course) {
        return '<button type="button" class="cp-chip' + (course.id === state.selectedId ? ' cp-chip-on' : '') +
            '" data-id="' + esc(course.id) + '" tabindex="-1">' + esc(course.name) + '</button>';
    }

    // Build results for the current query and refresh `state.options`.
    function renderResults() {
        const results = resultsEl();
        const count = container() && container().querySelector('.cp-count');
        if (!results) return;

        const q = state.query.trim();
        const options = [];
        let idx = 0;
        let html = '';

        if (!q) {
            // Quick-tap chips for recents + favorites (not in keyboard order).
            const recents = window.CourseData.getRecentIds().map((id) => state.byId[id]).filter(Boolean);
            const favs = window.CourseData.getFavoriteIds().map((id) => state.byId[id]).filter(Boolean);
            if (recents.length) {
                html += '<div class="cp-chips"><div class="cp-section-title">Recent</div>' +
                    '<div class="cp-chip-row">' + recents.map(chipHtml).join('') + '</div></div>';
            }
            if (favs.length) {
                html += '<div class="cp-chips"><div class="cp-section-title">Favorites</div>' +
                    '<div class="cp-chip-row">' + favs.map(chipHtml).join('') + '</div></div>';
            }
            // Cup-grouped browse list (keyboard navigable).
            state.cups.forEach((cup) => {
                html += '<div class="cp-section"><div class="cp-section-title">' + esc(cup.name) + '</div>';
                cup.courses.forEach((c) => {
                    const course = state.byId[c.id] || c;
                    html += rowHtml(course, idx);
                    options.push(course.id);
                    idx++;
                });
                html += '</div>';
            });
            if (count) count.hidden = true;
        } else {
            const matches = window.CourseData.rankCourses(state.courses, q);
            if (matches.length) {
                html += '<div class="cp-section">';
                matches.forEach((course) => {
                    html += rowHtml(course, idx);
                    options.push(course.id);
                    idx++;
                });
                html += '</div>';
            } else {
                html = '<div class="cp-empty">No courses match &ldquo;' + esc(q) + '&rdquo;</div>';
            }
            if (count) {
                count.hidden = false;
                count.textContent = matches.length + (matches.length === 1 ? ' course' : ' courses');
            }
        }

        results.innerHTML = html;
        state.options = options;
        // Keep active in range; default to first option when searching.
        if (q && options.length) state.active = 0;
        else if (state.active >= options.length) state.active = options.length - 1;
        syncActive();
    }

    // Reflect state.active into the DOM + aria, and scroll it into view.
    function syncActive() {
        const results = resultsEl();
        const search = searchEl();
        if (!results) return;
        results.querySelectorAll('.cp-row').forEach((row) => {
            const on = row.id === 'cp-opt-' + state.active;
            row.classList.toggle('cp-active', on);
            row.setAttribute('aria-selected', on || row.classList.contains('cp-selected') ? 'true' : 'false');
            if (on) {
                if (search) search.setAttribute('aria-activedescendant', row.id);
                if (row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
            }
        });
        if (state.active < 0 && search) search.removeAttribute('aria-activedescendant');
    }

    function moveActive(delta) {
        const n = state.options.length;
        if (!n) return;
        if (state.active < 0) state.active = delta > 0 ? 0 : n - 1;
        else state.active = (state.active + delta + n) % n;
        syncActive();
    }

    function selectActive() {
        const id = state.options[state.active];
        if (id && state.byId[id]) setSelected(state.byId[id]);
    }

    // ---- Open / close --------------------------------------------------------
    function openPanel() {
        const panel = panelEl();
        const search = searchEl();
        if (!panel) return;
        state.open = true;
        state.query = '';
        state.active = -1;
        panel.hidden = false;
        renderTrigger();
        if (search) search.value = '';
        renderResults();
        if (search) setTimeout(() => search.focus(), 20);

        outsideHandler = (e) => {
            const c = container();
            if (c && !c.contains(e.target)) closePanel();
        };
        document.addEventListener('mousedown', outsideHandler, true);
    }

    function closePanel() {
        const panel = panelEl();
        state.open = false;
        if (panel) panel.hidden = true;
        renderTrigger();
        if (outsideHandler) {
            document.removeEventListener('mousedown', outsideHandler, true);
            outsideHandler = null;
        }
    }

    function togglePanel() { state.open ? closePanel() : openPanel(); }

    // ---- Wiring --------------------------------------------------------------
    function wire(c) {
        const trigger = c.querySelector('.course-picker-trigger');
        if (trigger) trigger.addEventListener('click', togglePanel);

        const clearBtn = c.querySelector('.cp-clear');
        if (clearBtn) clearBtn.addEventListener('click', (e) => { e.stopPropagation(); clear(); });

        const search = c.querySelector('.course-picker-search');
        if (search) {
            search.addEventListener('input', (e) => { state.query = e.target.value; state.active = -1; renderResults(); });
            search.addEventListener('keydown', onKeydown);
        }

        const panel = c.querySelector('.course-picker-panel');
        if (panel) {
            panel.addEventListener('click', onPanelClick);
            panel.addEventListener('mousemove', onPanelHover);
            panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
            panel.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
        }
    }

    function onKeydown(e) {
        switch (e.key) {
            case 'ArrowDown': e.preventDefault(); moveActive(1); break;
            case 'ArrowUp': e.preventDefault(); moveActive(-1); break;
            case 'Home': e.preventDefault(); state.active = 0; syncActive(); break;
            case 'End': e.preventDefault(); state.active = state.options.length - 1; syncActive(); break;
            case 'Enter':
                e.preventDefault();
                if (state.active >= 0) selectActive();
                else if (state.options.length) { state.active = 0; selectActive(); }
                break;
            case 'Escape':
                e.preventDefault();
                closePanel();
                { const t = container() && container().querySelector('.course-picker-trigger'); if (t) t.focus(); }
                break;
            default: break;
        }
    }

    function onPanelClick(e) {
        const favBtn = e.target.closest('.cp-fav');
        if (favBtn) {
            e.stopPropagation();
            window.CourseData.toggleFavorite(favBtn.getAttribute('data-fav'));
            renderResults();
            return;
        }
        const chip = e.target.closest('.cp-chip');
        if (chip) { const c = state.byId[chip.getAttribute('data-id')]; if (c) setSelected(c); return; }
        const courseBtn = e.target.closest('.cp-course');
        if (courseBtn) { const c = state.byId[courseBtn.getAttribute('data-id')]; if (c) setSelected(c); }
    }

    function onPanelHover(e) {
        const courseBtn = e.target.closest('.cp-course');
        if (!courseBtn) return;
        const idx = parseInt(courseBtn.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && idx !== state.active) { state.active = idx; syncActive(); }
    }

    function renderShell() {
        const c = container();
        if (!c) return;
        c.innerHTML =
            '<label class="cp-field-label" id="cp-field-label">Course</label>' +
            '<div class="course-picker">' +
                '<div class="course-picker-control">' +
                    '<button type="button" class="course-picker-trigger" aria-haspopup="listbox" aria-expanded="false" aria-labelledby="cp-field-label">' +
                        '<span class="cp-icon" aria-hidden="true">🗺️</span>' +
                        '<span class="cp-label cp-placeholder">Select course (optional)</span>' +
                        '<span class="cp-caret" aria-hidden="true">▾</span>' +
                    '</button>' +
                    '<button type="button" class="cp-clear" title="Clear course" aria-label="Clear course" hidden>×</button>' +
                '</div>' +
                '<div class="course-picker-panel" role="listbox" aria-label="Courses" hidden>' +
                    '<input type="text" class="course-picker-search" role="combobox" aria-expanded="true" aria-autocomplete="list" ' +
                        'placeholder="Search course, cup or game..." autocomplete="off" spellcheck="false">' +
                    '<div class="cp-count" hidden></div>' +
                    '<div class="cp-results"></div>' +
                '</div>' +
            '</div>';
        wire(c);
        renderTrigger();
    }

    // (Re)load data for the active game version and rebuild the picker.
    async function init() {
        const c = container();
        if (!c || !window.CourseData) return;
        try {
            const gv = window.getCurrentGameVersion ? window.getCurrentGameVersion() : 'mk8d';
            const data = await window.CourseData.load(gv);
            state.courses = data.courses || [];
            state.cups = data.cups || [];
            state.byId = {};
            state.courses.forEach((course) => { state.byId[course.id] = course; });
            state.selectedId = null;
            state.selectedName = null;
            state.open = false;
            state.query = '';
            state.active = -1;
            renderShell();
        } catch (e) {
            console.warn('CoursePicker: course data unavailable', e);
            c.innerHTML = '';
        }
    }

    window.CoursePicker = {
        init: init,
        refresh: init,
        getSelected: getSelected,
        setSelected: setSelected,
        clear: clear,
        commit: commit
    };
})();
