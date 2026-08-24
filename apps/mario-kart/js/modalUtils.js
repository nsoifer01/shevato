// Modal utility functions for Mario Kart Tracker

// The one way an app modal is mounted. Every dialog (edit race, delete race,
// clear all, restore, createModal) goes through here so they all share:
//   - dialog semantics (role="dialog", aria-modal, aria-labelledby on the
//     .modal-title inside the dialog);
//   - ONE document keydown listener that is removed on EVERY close path
//     (Escape, buttons, backdrop). The old per-modal copies only removed it
//     on the Escape path, so each cancelled modal left a listener behind
//     that threw NotFoundError on the next Escape;
//   - a Tab focus trap inside the dialog and focus restored to the element
//     that opened it.
// Returns { modal, dialog, close }. `html` is the dialog's innerHTML; callers
// escape any stored strings before passing it.
let mkModalSeq = 0;
function presentModal({ dialogClass = '', html = '', initialFocus = null } = {}) {
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = ('modal-dialog ' + dialogClass).trim();
    dialog.setAttribute('role', 'dialog');
    dialog.setAttribute('aria-modal', 'true');
    dialog.innerHTML = html;

    const title = dialog.querySelector('.modal-title');
    if (title) {
        if (!title.id) title.id = 'mk-modal-title-' + (++mkModalSeq);
        dialog.setAttribute('aria-labelledby', title.id);
    }

    const opener = document.activeElement;
    const focusables = () => Array.from(dialog.querySelectorAll(
        'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
    ));

    let closed = false;
    const close = () => {
        if (closed) return;
        closed = true;
        document.removeEventListener('keydown', onKeydown);
        if (modal.parentNode) modal.parentNode.removeChild(modal);
        if (opener && typeof opener.focus === 'function' && document.contains(opener)) {
            opener.focus();
        }
    };

    const onKeydown = (e) => {
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
            return;
        }
        if (e.key !== 'Tab') return;
        const items = focusables();
        if (items.length === 0) { e.preventDefault(); return; }
        const first = items[0];
        const last = items[items.length - 1];
        const active = document.activeElement;
        if (e.shiftKey && (active === first || !dialog.contains(active))) {
            e.preventDefault();
            last.focus();
        } else if (!e.shiftKey && (active === last || !dialog.contains(active))) {
            e.preventDefault();
            first.focus();
        }
    };

    modal.appendChild(dialog);
    document.body.appendChild(modal);
    document.addEventListener('keydown', onKeydown);
    modal.addEventListener('click', (e) => { if (e.target === modal) close(); });

    const target = (initialFocus && dialog.querySelector(initialFocus)) || focusables()[0] || dialog;
    if (target === dialog) dialog.setAttribute('tabindex', '-1');
    if (typeof target.focus === 'function') target.focus();

    return { modal, dialog, close };
}
window.presentModal = presentModal;

/**
 * Creates a standardized modal with CSS classes instead of inline styles
 * @param {Object} config - Modal configuration
 * @param {string} config.icon - Emoji icon for the modal
 * @param {string} config.title - Modal title
 * @param {string} config.content - Modal HTML content
 * @param {Array} config.buttons - Array of button configurations
 * Modal styling uses consistent theme
 * @returns {HTMLElement} - The modal element
 */
function createModal({ icon, title, content, buttons = [] }) {
    const buttonHtml = buttons.map(btn => {
        const classes = ['modal-btn-primary', 'modal-btn-secondary', 'modal-btn-danger'];
        const buttonClass = classes[btn.type] || 'modal-btn-primary';
        return `<button id="${btn.id}" class="${buttonClass}">${btn.text}</button>`;
    }).join('');

    const { modal, close } = presentModal({
        html: `
        <div class="modal-icon">${icon}</div>
        <h3 class="modal-title">${title}</h3>
        <div class="modal-content">${content}</div>
        <div class="modal-buttons">${buttonHtml}</div>
    `,
    });

    buttons.forEach(btn => {
        const buttonEl = document.getElementById(btn.id);
        if (buttonEl && btn.onClick) {
            buttonEl.onclick = () => {
                btn.onClick();
                if (btn.closeOnClick !== false) close();
            };
        }
    });

    return modal;
}

/**
 * Creates a confirmation modal
 */
function createConfirmationModal({ icon, title, message, onConfirm, onCancel, isDestructive = false }) {
    const buttons = [
        {
            id: 'confirm-btn',
            text: isDestructive ? 'Delete' : 'Confirm',
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
        buttons,
    });
}

/**
 * Creates a form modal
 */
function createFormModal({ icon, title, fields, onSave, onCancel }) {
    const fieldsHtml = fields.map(field => {
        const fieldId = `form-${field.id}`;
        let inputHtml;

        switch (field.type) {
            case 'date':
                inputHtml = `<input type="date" id="${fieldId}" value="${field.value || ''}" class="form-input ">`;
                break;
            case 'time':
                inputHtml = `<input type="time" id="${fieldId}" value="${field.value || ''}" step="1" class="form-input " placeholder="${field.placeholder || ''}">`;
                break;
            case 'number':
                inputHtml = `<input type="number" id="${fieldId}" value="${field.value || ''}" min="${field.min || ''}" max="${field.max || ''}" class="form-input " placeholder="${field.placeholder || ''}">`;
                break;
            default:
                inputHtml = `<input type="text" id="${fieldId}" value="${field.value || ''}" class="form-input " placeholder="${field.placeholder || ''}">`;
        }

        if (field.grid) {
            return `
                <div class="form-group">
                    <label class="form-label " for="${fieldId}">${field.label}:</label>
                    ${inputHtml}
                </div>
            `;
        }

        return `
            <div class="form-group">
                <label class="form-label " for="${fieldId}">${field.label}:</label>
                ${inputHtml}
            </div>
        `;
    }).join('');

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
                onSave(formData);
            }
        },
        {
            id: 'cancel-btn',
            text: 'Cancel',
            type: 1, // secondary
            onClick: onCancel
        }
    ];

    const content = `<div class="form-container">${fieldsHtml}</div>`;

    return createModal({
        icon,
        title,
        content,
        buttons,
    });
}

// Export functions to global scope for compatibility
window.createModal = createModal;
window.createConfirmationModal = createConfirmationModal;
window.createFormModal = createFormModal;