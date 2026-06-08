// Course picker UI for the sidebar race form.
//
// Two experiences, one data layer:
//   - Mobile: a compact inline dropdown anchored under the field.
//   - Desktop: a centered Spotlight-style command palette overlay with a large
//     search, quick filters, recent searches, a two-column results + live
//     preview layout, and full keyboard navigation.
//
// Selection is read back by dataManager.addRace() via getSelected().
// Classic-script module. Data + ranking live in courseData.js.

(function () {
    'use strict';

    const esc = (s) => (window.escapeHtml ? window.escapeHtml(String(s)) : String(s));
    const DESKTOP_MQ = '(min-width: 760px)';
    function isDesktop() { return !!(window.matchMedia && window.matchMedia(DESKTOP_MQ).matches); }

    let state = {
        courses: [], cups: [], byId: {},
        selectedId: null, selectedName: null,
        open: false, mode: 'inline',     // 'inline' | 'modal'
        modalRoot: null,
        query: '', filter: 'all',        // all | favorites | recent | new | game:<name>
        options: [], active: -1
    };

    let outsideHandler = null;
    let resizeHandler = null;
    let savedBodyOverflow = null;

    // Stop the page behind the desktop modal from scrolling.
    function lockScroll() {
        if (savedBodyOverflow === null) {
            savedBodyOverflow = document.body.style.overflow || '';
            document.body.style.overflow = 'hidden';
        }
    }
    function unlockScroll() {
        if (savedBodyOverflow !== null) {
            document.body.style.overflow = savedBodyOverflow;
            savedBodyOverflow = null;
        }
    }

    // Visible, tabbable elements inside the modal (course/fav rows are
    // tabindex=-1 by design — they're reached via arrow keys, not Tab).
    function getFocusable() {
        if (!state.modalRoot) return [];
        const sel = 'a[href], button:not([disabled]):not([tabindex="-1"]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])';
        return Array.prototype.slice.call(state.modalRoot.querySelectorAll(sel))
            .filter((el) => el.offsetParent !== null || el === document.activeElement);
    }

    // Trap Tab within the modal and let Esc close it from anywhere inside.
    function onModalKeydown(e) {
        if (e.key === 'Escape') {
            e.preventDefault();
            closePanel();
            const t = container() && container().querySelector('.course-picker-trigger');
            if (t) t.focus();
            return;
        }
        if (e.key !== 'Tab') return;
        const fs = getFocusable();
        if (!fs.length) { e.preventDefault(); return; }
        const first = fs[0], last = fs[fs.length - 1];
        const a = document.activeElement;
        if (e.shiftKey) {
            if (a === first || !state.modalRoot.contains(a)) { e.preventDefault(); last.focus(); }
        } else {
            if (a === last || !state.modalRoot.contains(a)) { e.preventDefault(); first.focus(); }
        }
    }

    function container() { return document.getElementById('sidebar-course-picker'); }
    function root() { return state.mode === 'modal' ? state.modalRoot : container(); }
    function searchEl() { const r = root(); return r && r.querySelector('.course-picker-search'); }
    function resultsEl() { const r = root(); return r && r.querySelector('.cp-results'); }
    function countEl() { const r = root(); return r && r.querySelector('.cp-count'); }

    // ---- Public API ----------------------------------------------------------
    function getSelected() {
        return state.selectedId ? { id: state.selectedId, name: state.selectedName } : null;
    }
    function setSelected(course) {
        if (course && state.query.trim()) window.CourseData.pushRecentSearch(state.query);
        state.selectedId = course ? course.id : null;
        state.selectedName = course ? course.name : null;
        closePanel();
        renderTrigger();
    }
    function clear() { setSelected(null); }
    function commit() { if (state.selectedId) window.CourseData.pushRecent(state.selectedId); }

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

    // ---- Shared row rendering ------------------------------------------------
    function highlight(name, query) {
        const q = String(query || '').trim().toLowerCase();
        if (!q) return esc(name);
        const i = name.toLowerCase().indexOf(q);
        if (i === -1) return esc(name);
        return esc(name.slice(0, i)) + '<mark class="cp-hl">' + esc(name.slice(i, i + q.length)) + '</mark>' + esc(name.slice(i + q.length));
    }

    // Uniform, dense row: name (hero) + cup (secondary) + favorite star. Game
    // origin and new/returning status live in the preview, not on every row, so
    // the list scans cleanly and every row has the same shape.
    function rowHtml(course, idx) {
        const sel = course.id === state.selectedId;
        const fav = window.CourseData.isFavorite(course.id);
        const cups = (course.cups && course.cups.length) ? esc(course.cups.join(' / ')) : '';
        return (
            '<div class="cp-row' + (sel ? ' cp-selected' : '') + (idx === state.active ? ' cp-active' : '') +
                '" role="option" id="cp-opt-' + idx + '" aria-selected="' + (sel ? 'true' : 'false') + '">' +
                '<button type="button" class="cp-course" data-id="' + esc(course.id) + '" data-idx="' + idx + '" tabindex="-1">' +
                    '<span class="cp-name">' + highlight(course.name, state.query) + '</span>' +
                    (cups ? '<span class="cp-cup">' + cups + '</span>' : '') +
                '</button>' +
                (sel ? '<span class="cp-check" aria-hidden="true">✓</span>' : '') +
                '<button type="button" class="cp-fav' + (fav ? ' is-fav' : '') + '" data-fav="' + esc(course.id) +
                    '" tabindex="-1" aria-label="' + (fav ? 'Remove favorite from ' : 'Add favorite ') + esc(course.name) + '">' +
                    (fav ? '★' : '☆') + '</button>' +
            '</div>'
        );
    }

    function sectionHtml(title, courses, startIdx) {
        let html = '<div class="cp-section" role="group" aria-label="' + esc(title) + '"><div class="cp-section-title">' + esc(title) + '</div>';
        let idx = startIdx;
        courses.forEach((course) => { html += rowHtml(course, idx); idx++; });
        return { html: html + '</div>', next: idx };
    }

    // ---- Filters (desktop) ---------------------------------------------------
    function distinctGames() {
        const seen = [];
        state.courses.forEach((c) => { const g = c.game || c.origin; if (g && g !== 'new' && seen.indexOf(g) === -1) seen.push(g); });
        return seen;
    }
    function filterLabel(f) {
        if (f === 'all') return 'All courses';
        if (f === 'favorites') return 'Favorites';
        if (f === 'recent') return 'Recent';
        if (f === 'new') return 'New tracks';
        if (f.indexOf('game:') === 0) return f.slice(5);
        return f;
    }
    function filteredCourses() {
        const f = state.filter;
        if (f === 'favorites') return window.CourseData.getFavoriteIds().map((id) => state.byId[id]).filter(Boolean);
        if (f === 'recent') return window.CourseData.getRecentIds().map((id) => state.byId[id]).filter(Boolean);
        if (f === 'new') return state.courses.filter((c) => c.origin === 'new');
        if (f.indexOf('game:') === 0) { const g = f.slice(5); return state.courses.filter((c) => (c.game || c.origin) === g); }
        return state.courses;
    }

    // ---- Results (shared by both modes) --------------------------------------
    function renderResults() {
        const results = resultsEl();
        const count = countEl();
        if (!results) return;

        const q = state.query.trim();
        const base = filteredCourses();
        const options = [];
        let idx = 0;
        let html = '';

        if (!q) {
            if (state.filter === 'all') {
                // Cups only — no inline Recent/Favorites sections, so a track never
                // appears twice. Recent & Favorites live on the filter tabs.
                state.cups.forEach((cup) => {
                    const courses = cup.courses.map((c) => state.byId[c.id] || c);
                    const s = sectionHtml(cup.name, courses, idx); html += s.html; courses.forEach((c) => options.push(c.id)); idx = s.next;
                });
            } else {
                const s = sectionHtml(filterLabel(state.filter), base, idx);
                html += base.length ? s.html : '<div class="cp-noresult">Nothing here yet.</div>';
                base.forEach((c) => options.push(c.id)); idx = s.next;
            }
            if (count) {
                if (state.filter === 'all') { count.hidden = true; }
                else { count.hidden = false; count.textContent = base.length + (base.length === 1 ? ' course' : ' courses'); }
            }
        } else {
            const matches = window.CourseData.rankCourses(base, q);
            if (matches.length) {
                matches.forEach((course) => { html += rowHtml(course, idx); options.push(course.id); idx++; });
                html = '<div class="cp-section">' + html + '</div>';
            } else {
                html = '<div class="cp-noresult">No courses match &ldquo;' + esc(q) + '&rdquo;</div>';
            }
            if (count) { count.hidden = false; count.textContent = matches.length + (matches.length === 1 ? ' result' : ' results'); }
        }

        results.innerHTML = html;
        state.options = options;
        if (q && options.length) state.active = 0;
        else if (state.active >= options.length) state.active = options.length - 1;

        const clr = root() && root().querySelector('.cp-search-clear');
        if (clr) clr.hidden = !state.query;

        if (state.mode === 'modal') { renderFilters(); renderEmptyAside(); }
        syncActive();
    }

    function syncActive() {
        const results = resultsEl();
        const search = searchEl();
        if (results) {
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
        if (state.mode === 'modal') updatePreview();
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

    // ---- Desktop palette: filters, empty hints, preview ----------------------
    function renderFilters() {
        const wrap = state.modalRoot && state.modalRoot.querySelector('.cp-filters');
        if (!wrap) return;
        // Four essentials, each with a live count so their meaning is concrete.
        // Individual games stay reachable by typing ("mk7", "wii", ...).
        const favN = window.CourseData.getFavoriteIds().map((id) => state.byId[id]).filter(Boolean).length;
        const recN = window.CourseData.getRecentIds().map((id) => state.byId[id]).filter(Boolean).length;
        const newN = state.courses.filter((c) => c.origin === 'new').length;
        const chips = [['all', 'All', state.courses.length], ['favorites', 'Favorites', favN], ['recent', 'Recent', recN], ['new', 'New', newN]];
        wrap.innerHTML = chips.map(([f, label, n]) =>
            '<button type="button" class="cp-filter' + (state.filter === f ? ' is-on' : '') + '" data-filter="' + esc(f) + '">' +
                esc(label) + '<span class="cp-filter-n">' + n + '</span></button>'
        ).join('');
    }

    function renderEmptyAside() {
        const hint = state.modalRoot && state.modalRoot.querySelector('.cp-hint');
        const rs = state.modalRoot && state.modalRoot.querySelector('.cp-recent-searches');
        const showEmpty = !state.query.trim();
        if (hint) hint.hidden = !showEmpty;
        if (rs) {
            const searches = window.CourseData.getRecentSearches();
            if (showEmpty && searches.length) {
                rs.hidden = false;
                rs.innerHTML = '<span class="cp-rs-label">Recent searches</span>' +
                    searches.map((t) => '<button type="button" class="cp-rs-chip" data-search="' + esc(t) + '">' + esc(t) + '</button>').join('');
            } else { rs.hidden = true; rs.innerHTML = ''; }
        }
    }

    function previewHtml(course) {
        if (!course) {
            return '<div class="cp-preview-empty">' +
                '<div class="cp-preview-emoji">🗺️</div>' +
                '<p>Hover or arrow a course to preview it.</p></div>';
        }
        const fav = window.CourseData.isFavorite(course.id);
        const isNew = course.origin === 'new';
        const game = course.game || (isNew ? '' : course.origin);
        const cups = (course.cups && course.cups.length) ? esc(course.cups.join(' / ')) : '—';
        const sel = course.id === state.selectedId;
        return (
            '<div class="cp-pv">' +
                '<div class="cp-pv-name">' + esc(course.name) + '</div>' +
                '<span class="cp-pv-status' + (isNew ? ' is-new' : '') + '">' + (isNew ? 'New track' : 'Returning') + '</span>' +
                '<div class="cp-pv-meta">' +
                    '<div class="cp-pv-row"><span class="cp-pv-key">Cup</span><span class="cp-pv-val">' + cups + '</span></div>' +
                    (game ? '<div class="cp-pv-row"><span class="cp-pv-key">Game</span><span class="cp-pv-val">' + esc(game) + '</span></div>' : '') +
                '</div>' +
                '<button type="button" class="cp-preview-fav' + (fav ? ' is-fav' : '') + '" data-fav="' + esc(course.id) + '">' +
                    (fav ? '★ Favorited' : '☆ Add favorite') + '</button>' +
                '<button type="button" class="cp-preview-select' + (sel ? ' is-selected' : '') + '" data-id="' + esc(course.id) + '">' +
                    (sel ? '✓ Selected' : 'Select') + '</button>' +
            '</div>'
        );
    }
    function updatePreview() {
        const pv = state.modalRoot && state.modalRoot.querySelector('.cp-preview');
        if (!pv) return;
        const id = state.options[state.active];
        pv.innerHTML = previewHtml(id ? state.byId[id] : null);
    }

    // ---- Open / close --------------------------------------------------------
    function openPanel() { isDesktop() ? openModal() : openInline(); }

    function openInline() {
        state.mode = 'inline';
        state.filter = 'all';
        const panel = container() && container().querySelector('.course-picker-panel');
        const search = searchEl();
        if (!panel) return;
        state.open = true; state.query = ''; state.active = -1;
        panel.hidden = false;
        renderTrigger();
        if (search) search.value = '';
        renderResults();
        if (search) setTimeout(() => search.focus(), 20);
        bindDismiss();
    }

    function openModal() {
        state.mode = 'modal';
        state.open = true; state.query = ''; state.active = -1; state.filter = 'all';

        const overlay = document.createElement('div');
        overlay.className = 'cp-modal-backdrop';
        overlay.innerHTML =
            '<div class="cp-modal course-picker" role="dialog" aria-modal="true" aria-label="Find a course">' +
                '<div class="cp-modal-header">' +
                    '<span class="cp-modal-icon" aria-hidden="true">🔍</span>' +
                    '<input type="text" class="course-picker-search" role="combobox" aria-expanded="true" aria-autocomplete="list" ' +
                        'placeholder="Search courses…" autocomplete="off" spellcheck="false">' +
                    '<button type="button" class="cp-search-clear" aria-label="Clear search" hidden>×</button>' +
                    '<kbd class="cp-esc" title="Close">esc</kbd>' +
                '</div>' +
                '<div class="cp-modal-subbar">' +
                    '<div class="cp-filters"></div>' +
                    '<span class="cp-count" hidden></span>' +
                '</div>' +
                '<div class="cp-hint">Search by <b>course</b>, <b>cup</b>, <b>game</b>, or <b>abbreviation</b> — try &ldquo;DK&rdquo;, &ldquo;Mushroom Cup&rdquo;, or &ldquo;MK8&rdquo;.</div>' +
                '<div class="cp-recent-searches" hidden></div>' +
                '<div class="cp-modal-body">' +
                    '<div class="cp-results" role="listbox" aria-label="Courses"></div>' +
                    '<aside class="cp-preview"></aside>' +
                '</div>' +
                '<div class="cp-modal-foot"><kbd>↑</kbd><kbd>↓</kbd> navigate · <kbd>↵</kbd> select · <kbd>esc</kbd> close</div>' +
            '</div>';
        document.body.appendChild(overlay);
        state.modalRoot = overlay;

        const search = overlay.querySelector('.course-picker-search');
        if (search) {
            search.addEventListener('input', (e) => { state.query = e.target.value; state.active = -1; renderResults(); });
            search.addEventListener('keydown', onKeydown);
        }
        overlay.querySelector('.cp-results').addEventListener('mousemove', onPanelHover);
        overlay.addEventListener('click', onModalClick);
        overlay.addEventListener('keydown', onModalKeydown); // Tab trap + Esc

        lockScroll();
        renderTrigger();
        renderResults();
        if (search) setTimeout(() => search.focus(), 20);
        bindDismiss();
    }

    function closePanel() {
        unlockScroll();
        if (outsideHandler) { document.removeEventListener('mousedown', outsideHandler, true); outsideHandler = null; }
        if (resizeHandler) { window.removeEventListener('resize', resizeHandler); resizeHandler = null; }
        if (state.mode === 'modal') {
            if (state.modalRoot && state.modalRoot.parentNode) state.modalRoot.parentNode.removeChild(state.modalRoot);
            state.modalRoot = null;
        } else {
            const panel = container() && container().querySelector('.course-picker-panel');
            if (panel) panel.hidden = true;
        }
        state.mode = 'inline';
        state.open = false;
        renderTrigger();
    }

    function togglePanel() { state.open ? closePanel() : openPanel(); }

    function bindDismiss() {
        outsideHandler = (e) => {
            if (state.mode === 'modal') {
                // close when clicking the backdrop (outside the modal box)
                if (e.target === state.modalRoot) closePanel();
                return;
            }
            const c = container();
            if (c && !c.contains(e.target)) closePanel();
        };
        document.addEventListener('mousedown', outsideHandler, true);
        // If the viewport crosses the desktop/mobile boundary, reset cleanly.
        resizeHandler = () => { if (state.open && isDesktop() !== (state.mode === 'modal')) closePanel(); };
        window.addEventListener('resize', resizeHandler);
    }

    // ---- Events --------------------------------------------------------------
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
                e.preventDefault(); closePanel();
                { const t = container() && container().querySelector('.course-picker-trigger'); if (t) t.focus(); }
                break;
            default: break;
        }
    }

    function handleClickWithin(e) {
        const clearBtn = e.target.closest('.cp-search-clear');
        if (clearBtn) {
            e.stopPropagation();
            const s = searchEl();
            if (s) { s.value = ''; state.query = ''; state.active = -1; renderResults(); s.focus(); }
            return true;
        }
        const fav = e.target.closest('.cp-fav, .cp-preview-fav');
        if (fav) {
            e.stopPropagation();
            window.CourseData.toggleFavorite(fav.getAttribute('data-fav'));
            renderResults();
            return true;
        }
        const selectBtn = e.target.closest('.cp-preview-select');
        if (selectBtn) { const c = state.byId[selectBtn.getAttribute('data-id')]; if (c) setSelected(c); return true; }
        const courseBtn = e.target.closest('.cp-course');
        if (courseBtn) { const c = state.byId[courseBtn.getAttribute('data-id')]; if (c) setSelected(c); return true; }
        return false;
    }

    function onModalClick(e) {
        const filterBtn = e.target.closest('.cp-filter');
        if (filterBtn) { state.filter = filterBtn.getAttribute('data-filter'); state.active = -1; renderResults(); return; }
        const rsChip = e.target.closest('.cp-rs-chip');
        if (rsChip) {
            const term = rsChip.getAttribute('data-search');
            const s = searchEl();
            if (s) { s.value = term; state.query = term; state.active = -1; renderResults(); s.focus(); }
            return;
        }
        handleClickWithin(e);
    }

    function onPanelHover(e) {
        const courseBtn = e.target.closest('.cp-course');
        if (!courseBtn) return;
        const idx = parseInt(courseBtn.getAttribute('data-idx'), 10);
        if (!isNaN(idx) && idx !== state.active) { state.active = idx; syncActive(); }
    }

    // ---- Inline shell + wiring ----------------------------------------------
    function wireInline(c) {
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
            panel.addEventListener('click', (e) => { handleClickWithin(e); });
            panel.addEventListener('mousemove', onPanelHover);
            panel.addEventListener('wheel', (e) => e.stopPropagation(), { passive: true });
            panel.addEventListener('touchmove', (e) => e.stopPropagation(), { passive: true });
        }
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
                            'placeholder="Search courses…" autocomplete="off" spellcheck="false">' +
                        '<button type="button" class="cp-search-clear" aria-label="Clear search" hidden>×</button>' +
                        '<span class="cp-count" hidden></span>' +
                    '</div>' +
                    '<div class="cp-results"></div>' +
                '</div>' +
            '</div>';
        wireInline(c);
        renderTrigger();
    }

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
            if (state.open) closePanel();
            state.selectedId = null; state.selectedName = null;
            state.query = ''; state.active = -1; state.filter = 'all';
            renderShell();
        } catch (e) {
            console.warn('CoursePicker: course data unavailable', e);
            c.innerHTML = '';
        }
    }

    window.CoursePicker = {
        init: init, refresh: init,
        getSelected: getSelected, setSelected: setSelected, clear: clear, commit: commit
    };
})();
