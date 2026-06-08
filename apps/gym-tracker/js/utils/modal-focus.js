/**
 * Modal focus utilities.
 *
 * `trapModalFocus(modalEl)` — when the modal opens, save the currently
 * focused element, move focus to the modal's first focusable child, and
 * keep Tab cycling inside the modal until it closes. Esc closes the
 * modal (any element with `[data-modal-close]` or class `.modal-close`,
 * fallback: removes the `.active` class).
 *
 * Also locks body scroll for the duration: prevents the page behind the
 * modal from scrolling on both desktop and iOS Safari, with scrollbar-width
 * compensation to avoid layout jumps. Modal content itself remains
 * scrollable via .modal-content overflow-y:auto.
 *
 * The helper is idempotent — calling `trapModalFocus` on an already
 * trapped modal is a no-op. The trap auto-tears down when the modal's
 * `active` class is removed (observed via MutationObserver), and
 * focus is restored to whatever element was focused before the open.
 *
 * Stacked modals (e.g. confirm-modal over another modal) are handled: the
 * scroll lock releases only when the last modal closes, and focus returns
 * to the previously trapped modal rather than the page.
 */

const TRAPPED = new WeakMap(); // modalEl -> { observer, restore, keyHandler }

// Ordered stack of currently trapped modals (oldest first).
const TRAP_STACK = [];

// --- Scroll lock -----------------------------------------------------------

let _scrollY = 0;

function lockBodyScroll() {
    if (TRAP_STACK.length !== 0) return; // already locked
    _scrollY = window.scrollY;
    const scrollbarWidth = window.innerWidth - document.documentElement.clientWidth;
    document.body.style.paddingRight = scrollbarWidth > 0 ? `${scrollbarWidth}px` : '';
    document.body.style.top = `-${_scrollY}px`;
    document.body.classList.add('modal-open');
}

function unlockBodyScroll() {
    if (TRAP_STACK.length !== 0) return; // other modals still open
    document.body.classList.remove('modal-open');
    document.body.style.top = '';
    document.body.style.paddingRight = '';
    window.scrollTo(0, _scrollY);
}

// --------------------------------------------------------------------------

const FOCUSABLE_SELECTOR = [
    'a[href]',
    'area[href]',
    'button:not([disabled])',
    'input:not([disabled]):not([type="hidden"])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
].join(',');

function focusableElements(modalEl) {
    return Array.from(modalEl.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement);
}

function closeModal(modalEl) {
    // Mirrors the existing close patterns the views already use.
    const closeBtn = modalEl.querySelector('[data-modal-close], .modal-close');
    if (closeBtn instanceof HTMLElement) {
        closeBtn.click();
    } else {
        modalEl.classList.remove('active');
    }
}

export function trapModalFocus(modalEl) {
    if (!modalEl || TRAPPED.has(modalEl)) return;

    lockBodyScroll();

    const previouslyFocused = document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;

    // Move focus inside.
    const focusables = focusableElements(modalEl);
    const initial = modalEl.querySelector('[autofocus]') || focusables[0] || modalEl;
    if (initial instanceof HTMLElement) {
        // Defer so any in-flight render has a chance to land first.
        setTimeout(() => initial.focus(), 0);
    }

    const keyHandler = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            closeModal(modalEl);
            return;
        }
        if (e.key !== 'Tab') return;
        const items = focusableElements(modalEl);
        if (items.length === 0) {
            e.preventDefault();
            return;
        }
        const first = items[0];
        const last = items[items.length - 1];
        if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    modalEl.addEventListener('keydown', keyHandler);

    // When the modal closes (the `.active` class is removed), tear down
    // and restore focus to wherever it was before the modal opened.
    const observer = new MutationObserver(() => {
        if (!modalEl.classList.contains('active')) {
            untrapModalFocus(modalEl);
        }
    });
    observer.observe(modalEl, { attributes: true, attributeFilter: ['class'] });

    TRAP_STACK.push(modalEl);
    TRAPPED.set(modalEl, { observer, keyHandler, restore: previouslyFocused });
}

export function untrapModalFocus(modalEl) {
    const entry = TRAPPED.get(modalEl);
    if (!entry) return;
    entry.observer.disconnect();
    modalEl.removeEventListener('keydown', entry.keyHandler);
    TRAPPED.delete(modalEl);

    const idx = TRAP_STACK.indexOf(modalEl);
    if (idx !== -1) TRAP_STACK.splice(idx, 1);

    unlockBodyScroll();

    // Restore focus: if another modal is still open, focus its first
    // focusable element; otherwise return to wherever focus was before open.
    if (TRAP_STACK.length > 0) {
        const topModal = TRAP_STACK[TRAP_STACK.length - 1];
        setTimeout(() => {
            const items = focusableElements(topModal);
            if (items[0]) items[0].focus();
        }, 0);
    } else if (entry.restore && typeof entry.restore.focus === 'function') {
        // Defer so any close-side cleanup (e.g. removing the modal from
        // the accessibility tree) finishes before we shift focus.
        setTimeout(() => {
            try { entry.restore.focus(); } catch (_) { /* element may be gone */ }
        }, 0);
    }
}

/**
 * Convenience wrapper used by views: open a modal element by adding the
 * `.active` class, install the focus trap, and return.
 */
export function openModal(modalEl) {
    if (!modalEl) return;
    modalEl.classList.add('active');
    trapModalFocus(modalEl);
}

/**
 * R3-6: close a modal without leaving focus on a descendant while the modal
 * is being hidden / marked aria-hidden. Browsers log
 * "Blocked aria-hidden on an element because its descendant retained focus"
 * when an element with `aria-hidden="true"` (or one being hidden) still
 * contains document.activeElement. Move focus OUT first, then hide.
 *
 * `restoreTo` (optional) is where focus should land after closing; defaults
 * to document.body. Pass the destination view container when navigating away.
 */
export function closeModalSafely(modalEl, restoreTo) {
    if (!modalEl) return;
    // If focus is on (or inside) the modal, drop it before the modal goes
    // aria-hidden / display:none, so no focused element sits under aria-hidden.
    const active = document.activeElement;
    if (active instanceof HTMLElement && modalEl.contains(active)) {
        active.blur();
    }
    modalEl.classList.remove('active');
    if (modalEl.hasAttribute('aria-hidden')) {
        modalEl.setAttribute('aria-hidden', 'true');
    }
    const target = restoreTo instanceof HTMLElement ? restoreTo : document.body;
    if (typeof target.focus === 'function') {
        // body needs tabindex to be focusable for keyboard users; a transient
        // -1 tabindex is the standard trick and is removed on blur.
        if (target === document.body && !target.hasAttribute('tabindex')) {
            target.setAttribute('tabindex', '-1');
            target.addEventListener('blur', () => target.removeAttribute('tabindex'), { once: true });
        }
        target.focus({ preventScroll: true });
    }
}
