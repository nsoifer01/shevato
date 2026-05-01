/**
 * Modal focus utilities.
 *
 * `trapModalFocus(modalEl)` — when the modal opens, save the currently
 * focused element, move focus to the modal's first focusable child, and
 * keep Tab cycling inside the modal until it closes. Esc closes the
 * modal (any element with `[data-modal-close]` or class `.modal-close`,
 * fallback: removes the `.active` class).
 *
 * The helper is idempotent — calling `trapModalFocus` on an already
 * trapped modal is a no-op. The trap auto-tears down when the modal's
 * `active` class is removed (observed via MutationObserver), and
 * focus is restored to whatever element was focused before the open.
 */

const TRAPPED = new WeakMap(); // modalEl -> { observer, restore, keyHandler }

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

    TRAPPED.set(modalEl, { observer, keyHandler, restore: previouslyFocused });
}

export function untrapModalFocus(modalEl) {
    const entry = TRAPPED.get(modalEl);
    if (!entry) return;
    entry.observer.disconnect();
    modalEl.removeEventListener('keydown', entry.keyHandler);
    TRAPPED.delete(modalEl);
    if (entry.restore && typeof entry.restore.focus === 'function') {
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
