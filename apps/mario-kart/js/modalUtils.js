// Modal utility functions for Mario Kart Tracker

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
    const modal = document.createElement('div');
    modal.className = 'modal-overlay';

    const dialog = document.createElement('div');
    dialog.className = 'modal-dialog';

    const buttonHtml = buttons.map(btn => {
        const classes = ['modal-btn-primary', 'modal-btn-secondary', 'modal-btn-danger'];
        const buttonClass = classes[btn.type] || 'modal-btn-primary';
        const themeClass = '';
        return `<button id="${btn.id}" class="${buttonClass} ${themeClass}">${btn.text}</button>`;
    }).join('');

    dialog.innerHTML = `
        <div class="modal-icon">${icon}</div>
        <h3 class="modal-title">${title}</h3>
        <div class="modal-content">${content}</div>
        <div class="modal-buttons">${buttonHtml}</div>
    `;

    modal.appendChild(dialog);
    document.body.appendChild(modal);

    // Add event listeners for buttons
    buttons.forEach(btn => {
        const buttonEl = document.getElementById(btn.id);
        if (buttonEl && btn.onClick) {
            buttonEl.onclick = () => {
                btn.onClick();
                if (btn.closeOnClick !== false) {
                    document.body.removeChild(modal);
                }
            };
        }
    });

    // Close on background click
    modal.onclick = (e) => {
        if (e.target === modal) {
            document.body.removeChild(modal);
        }
    };

    // Close on Escape key
    const escapeHandler = (e) => {
        if (e.key === 'Escape') {
            document.body.removeChild(modal);
            document.removeEventListener('keydown', escapeHandler);
        }
    };
    document.addEventListener('keydown', escapeHandler);

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