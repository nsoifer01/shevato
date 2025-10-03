// Modal utility functions for Football H2H Tracker

/**
 * Creates a standardized modal with CSS classes
 * @param {Object} config - Modal configuration
 * @param {string} config.icon - Emoji icon for the modal
 * @param {string} config.title - Modal title
 * @param {string} config.content - Modal HTML content
 * @param {Array} config.buttons - Array of button configurations
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
        return `<button id="${btn.id}" class="${buttonClass}">${btn.text}</button>`;
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
                const result = btn.onClick();
                // Only close if onClick doesn't return false and closeOnClick is not false
                if (result !== false && btn.closeOnClick !== false) {
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

    return createModal({
        icon,
        title,
        content,
        buttons
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
function createFormModal({ icon, title, fields, onSave, onCancel }) {
    // Group fields for grid layout
    const gridFields = fields.filter(field => field.grid);
    const regularFields = fields.filter(field => !field.grid);
    
    let fieldsHtml = '';
    
    // Add grid fields first (date/time)
    if (gridFields.length > 0) {
        const gridFieldsHtml = gridFields.map(field => {
            const fieldId = `form-${field.id}`;
            let inputHtml;

            switch (field.type) {
                case 'date':
                    inputHtml = `<input type="date" id="${fieldId}" value="${field.value || ''}" class="form-input ">`;
                    break;
                case 'time':
                    const stepAttr = field.step ? `step="${field.step}"` : 'step="1"';
                    inputHtml = `<input type="time" id="${fieldId}" value="${field.value || ''}" ${stepAttr} class="form-input " placeholder="${field.placeholder || ''}">`;
                    break;
                case 'number':
                    const numberChangeHandler = field.onChange ? `onchange="${field.onChange}"` : '';
                    const numberValue = field.value !== undefined && field.value !== null ? field.value : '';
                    inputHtml = `<input type="number" id="${fieldId}" value="${numberValue}" min="${field.min || ''}" max="${field.max || ''}" class="form-input " placeholder="${field.placeholder || ''}" ${numberChangeHandler}>`;
                    break;
                case 'select':
                    const optionsHtml = field.options.map(option => 
                        `<option value="${option.value}" ${option.value === field.value ? 'selected' : ''}>${option.text}</option>`
                    ).join('');
                    const changeHandler = field.onChange ? `onchange="${field.onChange}"` : '';
                    inputHtml = `<select id="${fieldId}" class="form-input " ${changeHandler}>${optionsHtml}</select>`;
                    break;
                default:
                    const maxLengthAttr = field.maxlength ? `maxlength="${field.maxlength}"` : '';
                inputHtml = `<input type="text" id="${fieldId}" value="${field.value || ''}" class="form-input " placeholder="${field.placeholder || ''}" ${maxLengthAttr}>`;
            }

            const hideStyle = field.hidden ? 'style="display: none;"' : '';
            return `
                <div class="form-group" ${hideStyle}>
                    <label class="form-label " for="${fieldId}">${field.label}:</label>
                    ${inputHtml}
                </div>
            `;
        }).join('');
        
        fieldsHtml += `<div class="form-grid-2">${gridFieldsHtml}</div>`;
    }
    
    // Add regular fields
    const regularFieldsHtml = regularFields.map(field => {
        const fieldId = `form-${field.id}`;
        let inputHtml;

        switch (field.type) {
            case 'date':
                inputHtml = `<input type="date" id="${fieldId}" value="${field.value || ''}" class="form-input ">`;
                break;
            case 'time':
                const stepAttr2 = field.step ? `step="${field.step}"` : 'step="1"';
                inputHtml = `<input type="time" id="${fieldId}" value="${field.value || ''}" ${stepAttr2} class="form-input " placeholder="${field.placeholder || ''}">`;
                break;
            case 'number':
                const numberChangeHandler = field.onChange ? `onchange="${field.onChange}"` : '';
                const numberValue = field.value !== undefined && field.value !== null ? field.value : '';
                inputHtml = `<input type="number" id="${fieldId}" value="${numberValue}" min="${field.min || ''}" max="${field.max || ''}" class="form-input " placeholder="${field.placeholder || ''}" ${numberChangeHandler}>`;
                break;
            case 'select':
                const optionsHtml = field.options.map(option => 
                    `<option value="${option.value}" ${option.value === field.value ? 'selected' : ''}>${option.text}</option>`
                ).join('');
                const changeHandler = field.onChange ? `onchange="${field.onChange}"` : '';
                inputHtml = `<select id="${fieldId}" class="form-input " ${changeHandler}>${optionsHtml}</select>`;
                break;
            default:
                const maxLengthAttr = field.maxlength ? `maxlength="${field.maxlength}"` : '';
                inputHtml = `<input type="text" id="${fieldId}" value="${field.value || ''}" class="form-input " placeholder="${field.placeholder || ''}" ${maxLengthAttr}>`;
        }

        const hideStyle = field.hidden ? 'style="display: none;"' : '';
        return `
            <div class="form-group" ${hideStyle}>
                <label class="form-label " for="${fieldId}">${field.label}:</label>
                ${inputHtml}
            </div>
        `;
    }).join('');
    
    fieldsHtml += regularFieldsHtml;

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
                
                if (player1Goals !== '' && player2Goals !== '' && player1Goals === player2Goals) {
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
    
    // Add icon based on type
    const icons = {
        success: '✅',
        error: '✕',
        warning: '⚠️',
        info: 'ℹ️'
    };
    
    toast.innerHTML = `
        <span class="toast-icon">${icons[type] || icons.success}</span>
        <span class="toast-message">${message}</span>
    `;
    
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
window.showToast = showToast;
window.showFormError = showFormError;
window.hideFormError = hideFormError;