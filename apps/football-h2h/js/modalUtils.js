// Modal utility functions for Football H2H Tracker

// Count of currently-open modals across both modal shapes
// (.modal-overlay dialogs and the static #iconSelectorModal). Body scroll
// stays locked while this is > 0 and is restored only when the last
// modal closes.
let openModalCount = 0;

// Every value, label, option and placeholder that reaches a modal is
// escaped HERE, in the renderer, never at the input. Stored HTML in a note,
// team or player name used to execute when the edit or delete modal
// opened, and a `"` in a note truncated the field on every Edit (the value
// attribute closed early). Import and cloud sync deliver strings this page
// never typed, so the renderer is the only boundary that holds.
function esc(value) {
    return window.escapeHtml(value == null ? '' : value);
}

function lockBodyScroll() {
    openModalCount += 1;
    document.body.classList.add('modal-open');
}

function unlockBodyScroll() {
    openModalCount = Math.max(0, openModalCount - 1);
    if (openModalCount === 0) {
        document.body.classList.remove('modal-open');
    }
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container) {
    return Array.from(container.querySelectorAll(FOCUSABLE_SELECTOR))
        .filter(el => el.offsetParent !== null || el === document.activeElement);
}

// Move focus into the modal and trap Tab/Shift+Tab within it. Returns a
// teardown function that removes the trap and restores focus to the
// previously-focused element if it still exists.
function trapFocus(modal, dialog) {
    const previouslyFocused = document.activeElement;

    const focusFirst = () => {
        const focusable = getFocusable(modal);
        if (focusable.length) {
            focusable[0].focus();
        } else {
            dialog.setAttribute('tabindex', '-1');
            dialog.focus();
        }
    };
    focusFirst();

    const keydownHandler = (e) => {
        if (e.key !== 'Tab') return;
        const focusable = getFocusable(modal);
        if (!focusable.length) {
            e.preventDefault();
            return;
        }
        const first = focusable[0];
        const last = focusable[focusable.length - 1];
        if (!modal.contains(document.activeElement)) {
            // Focus escaped the modal (e.g. a deferred field rebuild
            // destroyed the focused element); pull the next Tab back in.
            e.preventDefault();
            first.focus();
        } else if (e.shiftKey && document.activeElement === first) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
        }
    };
    // Listen on document, not the modal: if focus lands outside the modal
    // the modal's own listener would never see the Tab keydown.
    document.addEventListener('keydown', keydownHandler);

    return () => {
        document.removeEventListener('keydown', keydownHandler);
        if (previouslyFocused && document.body.contains(previouslyFocused)) {
            previouslyFocused.focus();
        }
    };
}

/**
 * Creates a standardized modal with CSS classes
 * @param {Object} config - Modal configuration
 * @param {string} config.icon - Emoji icon for the modal
 * @param {string} config.title - Modal title
 * @param {string} config.content - Modal HTML content
 * @param {Array} config.buttons - Array of button configurations
 * @returns {HTMLElement} - The modal element
 */
let modalTitleSeq = 0;

function createModal({ icon, title, content, buttons = [], role = 'dialog' }) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog';

    // Dialog semantics. The focus trap and the Escape handler were already
    // here, but nothing TOLD assistive technology a dialog had opened: a
    // screen reader announced nothing when the Delete or Import confirmation
    // appeared and kept reading the page behind it. Every other app in the
    // repo marks its dialogs; this was the only one that did not.
    const titleId = `modal-title-${++modalTitleSeq}`;
    dialog.setAttribute('role', role);
    dialog.setAttribute('aria-modal', 'true');
    dialog.setAttribute('aria-labelledby', titleId);

    const buttonHtml = buttons.map(btn => {
        const classes = ['modal-btn-primary', 'modal-btn-secondary', 'modal-btn-danger'];
        const buttonClass = classes[btn.type] || 'modal-btn-primary';
        return `<button id="${esc(btn.id)}" class="${buttonClass}">${esc(btn.text)}</button>`;
    }).join('');

    dialog.innerHTML = `
        <div class="modal-icon">${esc(icon)}</div>
        <h3 class="modal-title" id="${titleId}">${esc(title)}</h3>
        <div class="modal-content">${content}</div>
        <div class="modal-buttons">${buttonHtml}</div>
    `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    lockBodyScroll();
    const releaseFocusTrap = trapFocus(modal, dialog);

    // Single teardown so every close path (button, background, Escape)
    // removes the document-level keydown listener. The previous version
    // only removed the listener on the Escape path, so opening +
    // dismissing modals via background-click or any button stacked
    // listeners that fired forever.
    let closed = false;
    const closeModal = () => {
        if (closed) return;
        closed = true;
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        document.removeEventListener('keydown', escapeHandler);
        releaseFocusTrap();
        unlockBodyScroll();
    };
    const escapeHandler = (e) => { if (e.key === 'Escape') closeModal(); };
    document.addEventListener('keydown', escapeHandler);

    buttons.forEach(btn => {
        const buttonEl = document.getElementById(btn.id);
        if (buttonEl && btn.onClick) {
            buttonEl.onclick = () => {
                const result = btn.onClick();
                if (result !== false && btn.closeOnClick !== false) closeModal();
            };
        }
    });

    modal.onclick = (e) => { if (e.target === modal) closeModal(); };

    return modal;
}

/**
 * Creates a confirmation modal
 */
function createConfirmationModal({ icon, title, message, onConfirm, onCancel, isDestructive = false, confirmText = null }) {
    const buttons = [
        {
            id: 'confirm-btn',
            text: confirmText || (isDestructive ? 'Delete' : 'Confirm'),
            type: isDestructive ? 2 : 0, // 2 = danger, 0 = primary
            onClick: onConfirm
        },
        {
            id: 'cancel-btn',
            text: 'Cancel',
            type: 1, // 1 = secondary
            onClick: onCancel
        }
    ];

    const content = `<p class="modal-text">${message}</p>`;

    return createModal({
        icon,
        title,
        content,
        buttons
    });
}

/**
 * Creates a success notification modal
 */
function createSuccessModal({ icon = '✅', title, message, onClose }) {
    const buttons = [
        {
            id: 'ok-btn',
            text: 'OK',
            type: 0, // primary
            onClick: onClose || (() => {})
        }
    ];

    const content = `<p class="modal-text">${message}</p>`;

    return createModal({
        icon,
        title,
        content,
        buttons
    });
}

/**
 * Creates an error notification modal
 */
function createErrorModal({ icon = '❌', title, message, onClose }) {
    const buttons = [
        {
            id: 'ok-btn',
            text: 'OK',
            type: 2, // danger
            onClick: onClose || (() => {})
        }
    ];

    const content = `<p class="modal-text">${message}</p>`;

    // alertdialog, not dialog: this one always reports something that already
    // went wrong, so a screen reader should interrupt rather than wait.
    return createModal({
        icon,
        title,
        content,
        buttons,
        role: 'alertdialog'
    });
}

/**
 * Creates a warning modal
 */
function createWarningModal({ icon = '⚠️', title, message, onConfirm, onCancel }) {
    const buttons = [
        {
            id: 'proceed-btn',
            text: 'Proceed',
            type: 0, // primary
            onClick: onConfirm
        },
        {
            id: 'cancel-btn',
            text: 'Cancel',
            type: 1, // secondary
            onClick: onCancel
        }
    ];

    const content = `<p class="modal-text modal-warning">${message}</p>`;

    return createModal({
        icon,
        title,
        content,
        buttons
    });
}

/**
 * Creates a form modal
 */
// Render the field markup for a form modal. Pure string builder exposed on
// window so the renderer-escaping tests can run it under node without a
// DOM: every interpolated value goes through esc(), attribute values
// included.
function renderFormFieldsHtml(fields) {
    function renderField(field) {
        const fieldId = `form-${esc(field.id)}`;
        const value = field.value === undefined || field.value === null ? '' : field.value;
        const placeholder = esc(field.placeholder || '');
        let inputHtml;

        switch (field.type) {
            case 'date':
                inputHtml = `<input type="date" id="${fieldId}" value="${esc(value)}" class="form-input">`;
                break;
            case 'time':
                const stepAttr = field.step ? `step="${esc(field.step)}"` : 'step="1"';
                inputHtml = `<input type="time" id="${fieldId}" value="${esc(value)}" ${stepAttr} class="form-input" placeholder="${placeholder}">`;
                break;
            case 'number':
                const numberChangeHandler = field.onChange ? `onchange="${esc(field.onChange)}"` : '';
                inputHtml = `<input type="number" id="${fieldId}" value="${esc(value)}" min="${esc(field.min || '')}" max="${esc(field.max || '')}" class="form-input" placeholder="${placeholder}" ${numberChangeHandler}>`;
                break;
            case 'select':
                const optionsHtml = field.options.map(option =>
                    `<option value="${esc(option.value)}" ${option.value === field.value ? 'selected' : ''}>${esc(option.text)}</option>`
                ).join('');
                const changeHandler = field.onChange ? `onchange="${esc(field.onChange)}"` : '';
                inputHtml = `<select id="${fieldId}" class="form-input" ${changeHandler}>${optionsHtml}</select>`;
                break;
            default:
                const maxLengthAttr = field.maxlength ? `maxlength="${esc(field.maxlength)}"` : '';
                inputHtml = `<input type="text" id="${fieldId}" value="${esc(value)}" class="form-input" placeholder="${placeholder}" ${maxLengthAttr}>`;
        }

        const hideStyle = field.hidden ? 'style="display: none;"' : '';
        // Remove trailing colon from label if present
        const labelText = field.label.endsWith(':') ? field.label.slice(0, -1) : field.label;
        return `
            <div class="form-group" ${hideStyle}>
                <label class="form-label" for="${fieldId}">${esc(labelText)}</label>
                ${inputHtml}
            </div>
        `;
    }

    // Group fields by type
    const gridFields = fields.filter(field => field.grid);
    const player1Fields = fields.filter(field => field.id.includes('player1'));
    const player2Fields = fields.filter(field => field.id.includes('player2'));
    const otherFields = fields.filter(field => !field.grid && !field.id.includes('player1') && !field.id.includes('player2'));

    let fieldsHtml = '';

    // Add grid fields first (date/time)
    if (gridFields.length > 0) {
        const gridFieldsHtml = gridFields.map(renderField).join('');
        fieldsHtml += `<div class="form-grid-2">${gridFieldsHtml}</div>`;
    }

    // Add other fields (like penalty winner)
    if (otherFields.length > 0) {
        fieldsHtml += otherFields.map(renderField).join('');
    }

    // Add Player 1 section
    if (player1Fields.length > 0) {
        const player1Name = player1Fields[0].label.split("'")[0] || 'Player 1';
        fieldsHtml += `
            <div class="form-divider"></div>
            <div class="player-section">
                <div class="player-section-title">⚽ ${esc(player1Name)}</div>
                ${player1Fields.map(renderField).join('')}
            </div>
        `;
    }

    // Add Player 2 section
    if (player2Fields.length > 0) {
        const player2Name = player2Fields[0].label.split("'")[0] || 'Player 2';
        fieldsHtml += `
            <div class="player-section">
                <div class="player-section-title">⚽ ${esc(player2Name)}</div>
                ${player2Fields.map(renderField).join('')}
            </div>
        `;
    }
    return fieldsHtml;
}

/**
 * Creates a form modal
 */
function createFormModal({ icon, title, fields, onSave, onCancel }) {
    const fieldsHtml = renderFormFieldsHtml(fields);

    const buttons = [
        {
            id: 'save-btn',
            text: 'Save Changes',
            type: 0, // primary
            onClick: () => {
                const formData = {};
                fields.forEach(field => {
                    const input = document.getElementById(`form-${field.id}`);
                    formData[field.id] = input ? input.value : '';
                });
                return onSave(formData);
            }
        },
        {
            id: 'cancel-btn',
            text: 'Cancel',
            type: 1, // secondary
            onClick: onCancel
        }
    ];

    const content = `
        <div class="form-error-container" id="form-error-container" style="display: none; background: #fef2f2; border: 1px solid #fecaca; color: #dc2626; padding: 12px; border-radius: 6px; margin-bottom: 16px; font-size: 14px;">
            <span id="form-error-message"></span>
        </div>
        <div class="form-container">${fieldsHtml}</div>
    `;

    const modal = createModal({
        icon,
        title,
        content,
        buttons,
    });
    
    // Add event listeners for dynamic penalty field visibility (for Football H2H edit modal)
    setTimeout(() => {
        const player1Input = document.getElementById('form-player1Goals');
        const player2Input = document.getElementById('form-player2Goals');
        const penaltyGroup = document.querySelector('[for="form-penaltyWinner"]')?.parentElement;
        
        if (player1Input && player2Input && penaltyGroup) {
            function checkForDraw() {
                const player1Goals = player1Input.value;
                const player2Goals = player2Input.value;
                
                const draw = window.FootballMatchLogic
                    ? window.FootballMatchLogic.isDraw(player1Goals, player2Goals)
                    : (player1Goals !== '' && player2Goals !== '' && player1Goals === player2Goals);
                if (draw) {
                    penaltyGroup.style.display = 'block';
                } else {
                    penaltyGroup.style.display = 'none';
                    // Clear penalty selection when hiding
                    const penaltySelect = document.getElementById('form-penaltyWinner');
                    if (penaltySelect) penaltySelect.value = '';
                }
            }
            
            // Initial check
            checkForDraw();
            
            // Add event listeners
            player1Input.addEventListener('input', checkForDraw);
            player2Input.addEventListener('input', checkForDraw);
        }
    }, 100);
    
    return modal;
}

// Show error in form modal
function showFormError(message) {
    const errorContainer = document.getElementById('form-error-container');
    const errorMessage = document.getElementById('form-error-message');
    
    if (errorContainer && errorMessage) {
        errorMessage.textContent = message;
        errorContainer.style.display = 'block';
    }
}

// Hide error in form modal
function hideFormError() {
    const errorContainer = document.getElementById('form-error-container');
    
    if (errorContainer) {
        errorContainer.style.display = 'none';
    }
}

/**
 * Creates a toast notification that appears at the top of the page and auto-disappears
 */
function showToast(message, type = 'success', duration = 3000) {
    // Create notification element
    const toast = document.createElement('div');
    toast.className = `toast toast-${type}`;
    // Announce it. Without a live region "Game added successfully!", "Game
    // deleted" and every error message were invisible to assistive tech,
    // which is the only feedback some of those actions give. `alert` for
    // errors so they interrupt, `status` otherwise.
    toast.setAttribute('role', type === 'error' ? 'alert' : 'status');
    toast.setAttribute('aria-live', type === 'error' ? 'assertive' : 'polite');
    
    // Add icon based on type
    const icons = {
        success: '✅',
        error: '✕',
        warning: '⚠️',
        info: 'ℹ️'
    };
    
    // Text, never markup: toast messages carry player names.
    const iconEl = document.createElement('span');
    iconEl.className = 'toast-icon';
    iconEl.textContent = icons[type] || icons.success;
    const messageEl = document.createElement('span');
    messageEl.className = 'toast-message';
    messageEl.textContent = message;
    toast.appendChild(iconEl);
    toast.appendChild(messageEl);
    
    // Add to body
    document.body.appendChild(toast);
    
    // Style the toast
    const colors = {
        success: '#10b981',
        error: '#ef4444',
        warning: '#f59e0b',
        info: '#3b82f6'
    };
    
    toast.style.cssText = `
        position: fixed;
        top: 80px;
        left: 50%;
        transform: translateX(-50%);
        padding: 15px 30px;
        background: ${colors[type] || colors.success};
        color: white;
        border-radius: 8px;
        box-shadow: 0 4px 15px rgba(0, 0, 0, 0.2);
        z-index: 9999;
        animation: slideDown 0.3s ease;
        display: flex;
        align-items: center;
        gap: 8px;
        font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
        font-weight: 600;
        max-width: 400px;
        word-wrap: break-word;
    `;
    
    // Remove after specified duration
    setTimeout(() => {
        toast.style.animation = 'slideOut 0.3s ease';
        setTimeout(() => {
            if (toast.parentNode) {
                toast.parentNode.removeChild(toast);
            }
        }, 300);
    }, duration);
}

// Export functions to global scope
window.createModal = createModal;
window.createConfirmationModal = createConfirmationModal;
window.createSuccessModal = createSuccessModal;
window.createErrorModal = createErrorModal;
window.createWarningModal = createWarningModal;
window.createFormModal = createFormModal;
window.renderFormFieldsHtml = renderFormFieldsHtml;
window.showToast = showToast;
window.showFormError = showFormError;
window.hideFormError = hideFormError;
window.lockBodyScroll = lockBodyScroll;
window.unlockBodyScroll = unlockBodyScroll;
window.trapFocus = trapFocus;