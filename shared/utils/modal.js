/**
 * Shared modal utilities
 * Used by football-h2h and mario-kart (identical implementations)
 */

/**
 * Creates a standardized modal with CSS classes
 * @param {Object} config - Modal configuration
 * @param {string} config.icon - Emoji icon for the modal
 * @param {string} config.title - Modal title
 * @param {string} config.content - Modal text content (plain text, not HTML)
 * @param {Array} config.buttons - Array of button configurations
 * @returns {HTMLElement} The modal overlay element
 */
export function createModal({ icon, title, content, buttons = [] }) {
  const modal = document.createElement('div');
  modal.className = 'modal-overlay';

  const dialog = document.createElement('div');
  dialog.className = 'modal-dialog';

  const iconDiv = document.createElement('div');
  iconDiv.className = 'modal-icon';
  iconDiv.textContent = icon;

  const titleEl = document.createElement('h3');
  titleEl.className = 'modal-title';
  titleEl.textContent = title;

  const contentDiv = document.createElement('div');
  contentDiv.className = 'modal-content';
  if (typeof content === 'string') {
    const p = document.createElement('p');
    p.className = 'modal-text';
    p.textContent = content;
    contentDiv.appendChild(p);
  } else if (content instanceof HTMLElement) {
    contentDiv.appendChild(content);
  }

  const buttonsDiv = document.createElement('div');
  buttonsDiv.className = 'modal-buttons';

  const buttonClasses = ['modal-btn-primary', 'modal-btn-secondary', 'modal-btn-danger'];

  buttons.forEach((btn) => {
    const buttonEl = document.createElement('button');
    buttonEl.id = btn.id;
    buttonEl.className = buttonClasses[btn.type] || 'modal-btn-primary';
    buttonEl.textContent = btn.text;

    if (btn.onClick) {
      buttonEl.onclick = () => {
        const result = btn.onClick();
        if (result !== false && btn.closeOnClick !== false) {
          document.body.removeChild(modal);
        }
      };
    }

    buttonsDiv.appendChild(buttonEl);
  });

  dialog.appendChild(iconDiv);
  dialog.appendChild(titleEl);
  dialog.appendChild(contentDiv);
  dialog.appendChild(buttonsDiv);
  modal.appendChild(dialog);
  document.body.appendChild(modal);

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
 * @param {string} config.message - Confirmation message (plain text)
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

  return createModal({ icon, title, content: message, buttons });
}

/**
 * Creates a success notification modal
 */
export function createSuccessModal({ icon = '\u2705', title, message, onClose }) {
  return createModal({
    icon,
    title,
    content: message,
    buttons: [{ id: 'ok-btn', text: 'OK', type: 0, onClick: onClose || (() => {}) }],
  });
}

/**
 * Creates an error notification modal
 */
export function createErrorModal({ icon = '\u274C', title, message, onClose }) {
  return createModal({
    icon,
    title,
    content: message,
    buttons: [{ id: 'ok-btn', text: 'OK', type: 2, onClick: onClose || (() => {}) }],
  });
}

/**
 * Creates a warning modal with confirm/cancel
 */
export function createWarningModal({ icon = '\u26A0\uFE0F', title, message, onConfirm, onCancel }) {
  return createModal({
    icon,
    title,
    content: message,
    buttons: [
      { id: 'proceed-btn', text: 'Proceed', type: 0, onClick: onConfirm },
      { id: 'cancel-btn', text: 'Cancel', type: 1, onClick: onCancel },
    ],
  });
}
