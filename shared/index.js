// Barrel export for shared utilities
export {
  getTodayDateString,
  parseLocalDate,
  formatDate,
  formatDateForDisplay,
} from './utils/date.js';
export { debounce } from './utils/debounce.js';
export { escapeHtml } from './utils/dom.js';
export {
  createModal,
  createConfirmationModal,
  createSuccessModal,
  createErrorModal,
  createWarningModal,
} from './utils/modal.js';
export { showToast } from './utils/toast.js';
export { storageGet, storageSet, storageRemove } from './utils/storage.js';
