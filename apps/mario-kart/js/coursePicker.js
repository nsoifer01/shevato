// Course picker UI for the sidebar race form.
//
// A command-palette style course selector: one calm surface, the course name
// as the hero of every row, forgiving ranked search, recent/favorite/cup
// groupings, and full keyboard navigation. Selection is read back by
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
        options: [],      // ids in current keyboard-navigable (top-to-bottom) order
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

    // ---- Closed trigger: two-line, always informative ------------------------
    function renderTrigger() {
        const c = container();
        if (!c) return;
        const primary = c.querySelector('.cp-trigger-primary');
        const secondary = c.querySelector('.cp-trigger-secondary');
        const clearBtn = c.querySelector('.cp-clear');
        const trigger = c.querySelector('.course-picker-trigger');

        if (state.selectedId) {
            const course = state.byId[state.selectedId];
            if (primary) { primary.textContent = state.selectedName; primary.classList.remove('cp-empty-primary'); }
            if (secondary) secondary.textContent = (course && course.cups && course.cups.length) ? course.cups.join(' / ') : 'Selected';
        } else {
            if (primary) { primary.textContent = 'Choose a course'; primary.classList.add('cp-empty-primary'); }
            if (secondary) secondary.textContent = 'Optional · tap to search';
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

    // One uniform row for EVERY context (recent, favorite, cup browse, search).
    // Line 1: course name (hero) + inline NEW badge. Line 2: cup (secondary) +
    // game source (tertiary, retro only). Star sits at the row's right edge.
    function rowHtml(course, idx) {
        const sel = course.id === state.selectedId;
        const fav = window.CourseData.isFavorite(course.id);
        const isNew = course.origin === 'new';
        const cups = (course.cups && course.cups.length) ? esc(course.cups.join(' / ')) : '';
        return (
            '<div class="cp-row' + (sel ? ' cp-selected' : '') + (idx === state.active ? ' cp-active' : '') +
                '" role="option" id="cp-opt-' + idx + '" aria-selected="' + (sel ? 'true' : 'false') + '">' +
                '<button type="button" class="cp-course" data-id="' + esc(course.id) + '" data-idx="' + idx + '" tabindex="-1">' +
                    '<span class="cp-line1">' +
                        '<span class="cp-name">' + highlight(course.name, state.query) + '</span>' +
                        (isNew ? '<span class="cp-badge">New</span>' : '') +
                    '</span>' +
                    '<span class="cp-sub">' +
                        (cups ? '<span class="cp-cup">' + cups + '</span>' : '') +
                        (!isNew && course.origin ? '<span class="cp-origin">' + esc(course.origin) + '</span>' : '') +
                    '</span>' +
                '</button>' +
                (sel ? '<span class="cp-check" aria-hidden="true">✓</span>' : '') +
                '<button type="button" class="cp-fav' + (fav ? ' is-fav' : '') + '" data-fav="' + esc(course.id) +
                    '" tabindex="-1" aria-label="' + (fav ? 'Remove favorite' : 'Add favorite') + '">' +
                    (fav ? '★' : '☆') + '</button>' +
            '</div>'
        );
    }

    function sectionHtml(title, courses, startIdx) {
        let html = '<div class="cp-section"><div class="cp-section-title">' + esc(title) + '</div>';
        let idx = startIdx;
        courses.forEach((course) => { html += rowHtml(course, idx); idx++; });
        return { html: html + '</div>', next: idx };
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

        const push = (courses) => courses.forEach((c) => options.push(c.id));

        if (!q) {
            const recents = window.CourseData.getRecentIds().map((id) => state.byId[id]).filter(Boolean);
            const favs = window.CourseData.getFavoriteIds().map((id) => state.byId[id]).filter(Boolean);
            if (recents.length) {
                const s = sectionHtml('Recent', recents, idx); html += s.html; push(recents); idx = s.next;
            }
            if (favs.length) {
                const s = sectionHtml('Favorites', favs, idx); html += s.html; push(favs); idx = s.next;
            }
            state.cups.forEach((cup) => {
                const courses = cup.courses.map((c) => state.byId[c.id] || c);
                const s = sectionHtml(cup.name, courses, idx); html += s.html; push(courses); idx = s.next;
            });
            if (count) count.hidden = true;
        } else {
            const matches = window.CourseData.rankCourses(state.courses, q);
            if (matches.length) {
                matches.forEach((course) => { html += rowHtml(course, idx); options.push(course.id); idx++; });
                html = '<div class="cp-section">' + html + '</div>';
            } else {
                html = '<div class="cp-noresult">No courses match &ldquo;' + esc(q) + '&rdquo;</div>';
            }
            if (count) {
                count.hidden = false;
                count.textContent = matches.length + (matches.length === 1 ? ' result' : ' results');
            }
        }

        results.innerHTML = html;
        state.options = options;
        if (q && options.length) state.active = 0;       // first hit pre-armed for Enter
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
                        '<span class="cp-trigger-text">' +
                            '<span class="cp-trigger-primary cp-empty-primary">Choose a course</span>' +
                            '<span class="cp-trigger-secondary">Optional · tap to search</span>' +
                        '</span>' +
                        '<span class="cp-caret" aria-hidden="true">▾</span>' +
                    '</button>' +
                    '<button type="button" class="cp-clear" aria-label="Clear course" hidden>×</button>' +
                '</div>' +
                '<div class="course-picker-panel" role="listbox" aria-label="Courses" hidden>' +
                    '<div class="cp-search-wrap">' +
                        '<span class="cp-search-icon" aria-hidden="true">🔍</span>' +
                        '<input type="text" class="course-picker-search" role="combobox" aria-expanded="true" aria-autocomplete="list" ' +
                            'placeholder="Search course, cup or game" autocomplete="off" spellcheck="false">' +
                        '<span class="cp-count" hidden></span>' +
                    '</div>' +
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
