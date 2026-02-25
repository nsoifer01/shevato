// Modal utility functions for Football H2H Tracker

import {
  createModal,
  createConfirmationModal,
  createSuccessModal,
  createErrorModal,
  createWarningModal,
} from '../../../shared/utils/modal.js';

// Re-export shared modal utilities
export {
  createModal,
  createConfirmationModal,
  createSuccessModal,
  createErrorModal,
  createWarningModal,
};

// Football H2H uses a custom toast with icons and inline styles
export function showToast(message, type = 'success', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;

  const icons = {
    success: '✅',
    error: '✕',
    warning: '⚠️',
    info: 'ℹ️',
  };

  const iconSpan = document.createElement('span');
  iconSpan.className = 'toast-icon';
  iconSpan.textContent = icons[type] || icons.success;
  const msgSpan = document.createElement('span');
  msgSpan.className = 'toast-message';
  msgSpan.textContent = message;
  toast.append(iconSpan, msgSpan);

  document.body.appendChild(toast);

  const colors = {
    success: '#10b981',
    error: '#ef4444',
    warning: '#f59e0b',
    info: '#3b82f6',
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

  setTimeout(() => {
    toast.style.animation = 'slideOut 0.3s ease';
    setTimeout(() => {
      if (toast.parentNode) {
        toast.parentNode.removeChild(toast);
      }
    }, 300);
  }, duration);
}

// Football H2H specific: form modal for editing games
export function createFormModal({ icon, title, fields, onSave, onCancel }) {
  function renderField(field) {
    const fieldId = `form-${field.id}`;
    let inputHtml;

    switch (field.type) {
      case 'date':
        inputHtml = `<input type="date" id="${fieldId}" value="${field.value || ''}" class="form-input">`;
        break;
      case 'time': {
        const stepAttr = field.step ? `step="${field.step}"` : 'step="1"';
        inputHtml = `<input type="time" id="${fieldId}" value="${field.value || ''}" ${stepAttr} class="form-input" placeholder="${field.placeholder || ''}">`;
        break;
      }
      case 'number': {
        const numberChangeHandler = field.onChange ? `onchange="${field.onChange}"` : '';
        const numberValue = field.value !== undefined && field.value !== null ? field.value : '';
        inputHtml = `<input type="number" id="${fieldId}" value="${numberValue}" min="${field.min || ''}" max="${field.max || ''}" class="form-input" placeholder="${field.placeholder || ''}" ${numberChangeHandler}>`;
        break;
      }
      case 'select': {
        const optionsHtml = field.options
          .map(
            (option) =>
              `<option value="${option.value}" ${option.value === field.value ? 'selected' : ''}>${option.text}</option>`,
          )
          .join('');
        const changeHandler = field.onChange ? `onchange="${field.onChange}"` : '';
        inputHtml = `<select id="${fieldId}" class="form-input" ${changeHandler}>${optionsHtml}</select>`;
        break;
      }
      default: {
        const maxLengthAttr = field.maxlength ? `maxlength="${field.maxlength}"` : '';
        inputHtml = `<input type="text" id="${fieldId}" value="${field.value || ''}" class="form-input" placeholder="${field.placeholder || ''}" ${maxLengthAttr}>`;
      }
    }

    const hideStyle = field.hidden ? 'style="display: none;"' : '';
    const labelText = field.label.endsWith(':') ? field.label.slice(0, -1) : field.label;
    return `
      <div class="form-group" ${hideStyle}>
        <label class="form-label" for="${fieldId}">${labelText}</label>
        ${inputHtml}
      </div>
    `;
  }

  const gridFields = fields.filter((field) => field.grid);
  const player1Fields = fields.filter((field) => field.id.includes('player1'));
  const player2Fields = fields.filter((field) => field.id.includes('player2'));
  const otherFields = fields.filter(
    (field) => !field.grid && !field.id.includes('player1') && !field.id.includes('player2'),
  );

  let fieldsHtml = '';

  if (gridFields.length > 0) {
    const gridFieldsHtml = gridFields.map(renderField).join('');
    fieldsHtml += `<div class="form-grid-2">${gridFieldsHtml}</div>`;
  }

  if (otherFields.length > 0) {
    fieldsHtml += otherFields.map(renderField).join('');
  }

  if (player1Fields.length > 0) {
    const player1Name = player1Fields[0].label.split("'")[0] || 'Player 1';
    fieldsHtml += `
      <div class="form-divider"></div>
      <div class="player-section">
        <div class="player-section-title">\u26BD ${player1Name}</div>
        ${player1Fields.map(renderField).join('')}
      </div>
    `;
  }

  if (player2Fields.length > 0) {
    const player2Name = player2Fields[0].label.split("'")[0] || 'Player 2';
    fieldsHtml += `
      <div class="player-section">
        <div class="player-section-title">\u26BD ${player2Name}</div>
        ${player2Fields.map(renderField).join('')}
      </div>
    `;
  }

  const buttons = [
    {
      id: 'save-btn',
      text: 'Save Changes',
      type: 0,
      onClick: () => {
        const formData = {};
        fields.forEach((field) => {
          const input = document.getElementById(`form-${field.id}`);
          formData[field.id] = input ? input.value : '';
        });
        return onSave(formData);
      },
    },
    {
      id: 'cancel-btn',
      text: 'Cancel',
      type: 1,
      onClick: onCancel,
    },
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

  setTimeout(() => {
    const player1Input = document.getElementById('form-player1Goals');
    const player2Input = document.getElementById('form-player2Goals');
    const penaltyGroup = document.querySelector('[for="form-penaltyWinner"]')?.parentElement;

    if (player1Input && player2Input && penaltyGroup) {
      function checkForDraw() {
        const p1Goals = player1Input.value;
        const p2Goals = player2Input.value;

        if (p1Goals !== '' && p2Goals !== '' && p1Goals === p2Goals) {
          penaltyGroup.style.display = 'block';
        } else {
          penaltyGroup.style.display = 'none';
          const penaltySelect = document.getElementById('form-penaltyWinner');
          if (penaltySelect) penaltySelect.value = '';
        }
      }

      checkForDraw();
      player1Input.addEventListener('input', checkForDraw);
      player2Input.addEventListener('input', checkForDraw);
    }
  }, 100);

  return modal;
}

export function showFormError(message) {
  const errorContainer = document.getElementById('form-error-container');
  const errorMessage = document.getElementById('form-error-message');

  if (errorContainer && errorMessage) {
    errorMessage.textContent = message;
    errorContainer.style.display = 'block';
  }
}

export function hideFormError() {
  const errorContainer = document.getElementById('form-error-container');

  if (errorContainer) {
    errorContainer.style.display = 'none';
  }
}
