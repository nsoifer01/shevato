/**
 * Shared modal utilities
 * Used by football-h2h and mario-kart (identical implementations)
 */

/**
 * Creates a standardized modal with CSS classes
 * @param {Object} config - Modal configuration
 * @param {string} config.icon - Emoji icon for the modal
 * @param {string} config.title - Modal title
 * @param {string} config.content - Modal HTML content
 * @param {Array} config.buttons - Array of button configurations
 * @returns {HTMLElement} The modal overlay element
 */
export function createModal({ icon, title, content, buttons = [] }) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';

  const buttonHtml = buttons
    .map((btn) => {
      const classes = ['modal-btn-primary', 'modal-btn-secondary', 'modal-btn-danger'];
      const buttonClass = classes[btn.type] || 'modal-btn-primary';
      return `<button id="${btn.id}" class="${buttonClass}">${btn.text}</button>`;
    })
    .join('');

  dialog.innerHTML = `
    <div class="modal-icon">${icon}</div>
    <h3 class="modal-title">${title}</h3>
    <div class="modal-content">${content}</div>
    <div class="modal-buttons">${buttonHtml}</div>
  `;

  modal.appendChild(dialog);
  document.body.appendChild(modal);

  // Add event listeners for buttons
  buttons.forEach((btn) => {
    const buttonEl = document.getElementById(btn.id);
    if (buttonEl && btn.onClick) {
      buttonEl.onclick = () => {
        const result = btn.onClick();
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
 * @param {Object} config
 * @param {string} config.icon - Emoji icon
 * @param {string} config.title - Modal title
 * @param {string} config.message - Confirmation message
 * @param {Function} config.onConfirm - Confirm callback
 * @param {Function} config.onCancel - Cancel callback
 * @param {boolean} config.isDestructive - Use danger styling
 * @returns {HTMLElement}
 */
export function createConfirmationModal({
  icon,
  title,
  message,
  onConfirm,
  onCancel,
  isDestructive = false,
}) {
  const buttons = [
    {
      id: 'confirm-btn',
      text: isDestructive ? 'Delete' : 'Confirm',
      type: isDestructive ? 2 : 0,
      onClick: onConfirm,
    },
    {
      id: 'cancel-btn',
      text: 'Cancel',
      type: 1,
      onClick: onCancel,
    },
  ];

  const content = `<p class="modal-text">${message}</p>`;

  return createModal({ icon, title, content, buttons });
}

/**
 * Creates a success notification modal
 */
export function createSuccessModal({ icon = '✅', title, message, onClose }) {
  return createModal({
    icon,
    title,
    content: `<p class="modal-text">${message}</p>`,
    buttons: [{ id: 'ok-btn', text: 'OK', type: 0, onClick: onClose || (() => {}) }],
  });
}

/**
 * Creates an error notification modal
 */
export function createErrorModal({ icon = '❌', title, message, onClose }) {
  return createModal({
    icon,
    title,
    content: `<p class="modal-text">${message}</p>`,
    buttons: [{ id: 'ok-btn', text: 'OK', type: 2, onClick: onClose || (() => {}) }],
  });
}

/**
 * Creates a warning modal with confirm/cancel
 */
export function createWarningModal({ icon = '⚠️', title, message, onConfirm, onCancel }) {
  return createModal({
    icon,
    title,
    content: `<p class="modal-text modal-warning">${message}</p>`,
    buttons: [
      { id: 'proceed-btn', text: 'Proceed', type: 0, onClick: onConfirm },
      { id: 'cancel-btn', text: 'Cancel', type: 1, onClick: onCancel },
    ],
  });
}
