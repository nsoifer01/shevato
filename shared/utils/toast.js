/**
 * Show a toast notification
 * Uses CSS classes for styling (expects .toast and .toast.show in app CSS)
 * @param {string} message - Message to display
 * @param {'info'|'success'|'error'|'warning'} type - Toast type
 * @param {number} duration - Duration in milliseconds
 */
export function showToast(message, type = 'info', duration = 3000) {
  const toast = document.createElement('div');
  toast.className = `toast toast-${type}`;
  toast.textContent = message;

  document.body.appendChild(toast);

  // Stack toasts vertically
  const existingToasts = document.querySelectorAll('.toast.show');
  let offset = 80;
  existingToasts.forEach((existingToast) => {
    const rect = existingToast.getBoundingClientRect();
    offset = Math.max(offset, rect.bottom + 10);
  });
  toast.style.top = `${offset}px`;

  setTimeout(() => {
    toast.classList.add('show');
  }, 10);

  setTimeout(() => {
    toast.classList.remove('show');
    setTimeout(() => {
      if (toast.parentNode) {
        document.body.removeChild(toast);
      }
    }, 300);
  }, duration);
}
