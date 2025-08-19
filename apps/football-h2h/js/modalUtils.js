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
window.showToast = showToast;