/**
 * Pagination utility — pure functions for page-slice math.
 *
 * Usage:
 *   const state = makePaginatorState(15);       // page size 15, starts at page 1
 *   const info  = paginatorInfo(state, total);  // { page, pageCount, start, end }
 *   state.page  = 1;                            // reset to first page
 */

/**
 * Create a mutable pagination state object.
 * @param {number} pageSize
 * @returns {{ page: number, pageSize: number }}
 */
export function makePaginatorState(pageSize) {
    return { page: 1, pageSize };
}

/**
 * Derive read-only pagination info from state + total item count.
 * @param {{ page: number, pageSize: number }} state
 * @param {number} total
 * @returns {{ page: number, pageCount: number, start: number, end: number }}
 *   start/end are 0-based array indices (exclusive end) for Array.slice().
 */
export function paginatorInfo(state, total) {
    const pageCount = total === 0 ? 1 : Math.ceil(total / state.pageSize);
    const page = Math.min(Math.max(state.page, 1), pageCount);
    const start = (page - 1) * state.pageSize;
    const end = Math.min(start + state.pageSize, total);
    return { page, pageCount, start, end };
}

/**
 * Compute the windowed sequence of page numbers/ellipses for a paginator.
 *
 * Rules:
 *   - First and last page are always included.
 *   - Current page and its immediate neighbors (±1) are always included.
 *   - '...' is inserted where consecutive numbers are skipped (gap > 1).
 *   - When total <= 7, all pages are shown with no ellipsis.
 *
 * @param {number} page       current page (1-based)
 * @param {number} pageCount  total number of pages
 * @returns {(number|'...')[]}  ordered sequence, e.g. [1,'...',4,5,6,'...',12]
 */
export function pageWindowSequence(page, pageCount) {
    if (pageCount <= 1) return [];

    const set = new Set([1, pageCount]);
    for (let i = page - 1; i <= page + 1; i++) {
        if (i >= 1 && i <= pageCount) set.add(i);
    }
    if (pageCount <= 7) {
        for (let i = 1; i <= pageCount; i++) set.add(i);
    }

    const sorted = [...set].sort((a, b) => a - b);
    const out = [];
    let prev = 0;
    for (const n of sorted) {
        if (n - prev > 1) out.push('...');
        out.push(n);
        prev = n;
    }
    return out;
}

/**
 * Build the pagination controls HTML string for BOTH top and bottom blocks.
 * Returns an empty string when there is only one page (or zero items).
 *
 * Each block gets unique IDs by appending a suffix ('t' for top, 'b' for bottom).
 *
 * @param {{ page: number, pageCount: number }} info
 * @param {string} idPrefix   - prefix for button ids (e.g. 'ex' or 'hist')
 * @returns {{ top: string, bottom: string }} HTML fragments
 */
export function paginatorDualHTML(info, idPrefix) {
    if (info.pageCount <= 1) return { top: '', bottom: '' };

    function buildBlock(suffix) {
        const prevDisabled = info.page <= 1 ? ' disabled aria-disabled="true"' : '';
        const nextDisabled = info.page >= info.pageCount ? ' disabled aria-disabled="true"' : '';
        const sequence = pageWindowSequence(info.page, info.pageCount);

        const numbersHTML = sequence.map(n => {
            if (n === '...') {
                return `<span class="pagination-ellipsis" aria-hidden="true">…</span>`;
            }
            const isActive = n === info.page;
            const ariaCurrent = isActive ? ' aria-current="page"' : '';
            const activeClass = isActive ? ' pagination-page-active' : '';
            return `<button type="button" id="${idPrefix}-page-${n}-${suffix}" class="btn pagination-page-btn${activeClass}"${ariaCurrent} aria-label="Page ${n}" data-page="${n}">${n}</button>`;
        }).join('');

        return `
            <div class="pagination-controls" role="navigation" aria-label="Page navigation" data-paginator="${idPrefix}-${suffix}">
                <button type="button" id="${idPrefix}-prev-${suffix}" class="btn btn-ghost btn-sm pagination-btn"${prevDisabled}
                        aria-label="Previous page">
                    <i class="fas fa-chevron-left" aria-hidden="true"></i> Prev
                </button>
                ${numbersHTML}
                <button type="button" id="${idPrefix}-next-${suffix}" class="btn btn-ghost btn-sm pagination-btn"${nextDisabled}
                        aria-label="Next page">
                    Next <i class="fas fa-chevron-right" aria-hidden="true"></i>
                </button>
            </div>
        `.trim();
    }

    return { top: buildBlock('t'), bottom: buildBlock('b') };
}

/**
 * Build the pagination controls HTML string.
 * Returns an empty string when there is only one page (or zero items).
 *
 * @param {{ page: number, pageCount: number }} info
 * @param {string} prevId  - id for the Prev button
 * @param {string} nextId  - id for the Next button
 * @param {string} labelId - id for the "Page X of Y" span
 * @returns {string} HTML fragment
 */
export function paginatorHTML(info, prevId, nextId, labelId) {
    if (info.pageCount <= 1) return '';

    const prevDisabled = info.page <= 1 ? ' disabled aria-disabled="true"' : '';
    const nextDisabled = info.page >= info.pageCount ? ' disabled aria-disabled="true"' : '';

    return `
        <div class="pagination-controls" role="navigation" aria-label="Page navigation">
            <button id="${prevId}" class="btn btn-ghost btn-sm pagination-btn"${prevDisabled}
                    aria-label="Previous page">
                <i class="fas fa-chevron-left" aria-hidden="true"></i> Prev
            </button>
            <span id="${labelId}" class="pagination-label" aria-live="polite" aria-atomic="true">
                Page ${info.page} of ${info.pageCount}
            </span>
            <button id="${nextId}" class="btn btn-ghost btn-sm pagination-btn"${nextDisabled}
                    aria-label="Next page">
                Next <i class="fas fa-chevron-right" aria-hidden="true"></i>
            </button>
        </div>
    `.trim();
}
