// Date widget and calendar dropdown functionality
// Extracted from main.js

import { state } from './store.js';

export function toggleDateWidget(event) {
  if (event && event.type === 'keydown') {
    event.preventDefault();
  }

  const dropdown = document.getElementById('calendar-dropdown');
  const dateInput = document.getElementById('date');

  let dateButton = event && event.currentTarget ? event.currentTarget : null;
  if (!dateButton) {
    dateButton =
      document.getElementById('date-button') || document.getElementById('date-button-sidebar');
  }

  if (!dropdown || !dateButton || !dateInput) {
    console.error('Calendar dropdown elements not found');
    return;
  }

  const isOpen = dropdown.classList.contains('open');

  if (isOpen) {
    dropdown.classList.remove('open');
    dateButton.setAttribute('aria-expanded', 'false');
    const otherButton =
      dateButton.id === 'date-button'
        ? document.getElementById('date-button-sidebar')
        : document.getElementById('date-button');
    if (otherButton) {
      otherButton.setAttribute('aria-expanded', 'false');
    }
  } else {
    closeAllDropdowns();

    const rect = dateButton.getBoundingClientRect();
    dropdown.style.position = 'fixed';
    dropdown.style.top = rect.bottom + 5 + 'px';
    dropdown.style.left = rect.left + 'px';

    dropdown.classList.add('open');
    dateButton.setAttribute('aria-expanded', 'true');
    const otherButton =
      dateButton.id === 'date-button'
        ? document.getElementById('date-button-sidebar')
        : document.getElementById('date-button');
    if (otherButton) {
      otherButton.setAttribute('aria-expanded', 'true');
    }

    dropdown.setAttribute('data-just-opened', 'true');
    setTimeout(() => {
      dropdown.removeAttribute('data-just-opened');
    }, 100);
  }
}

export function closeAllDropdowns() {
  const dropdowns = document.querySelectorAll('.widget-dropdown, .calendar-dropdown');
  dropdowns.forEach((dropdown) => {
    dropdown.classList.remove('open');
  });

  const dateButton = document.getElementById('date-button');
  const dateButtonSidebar = document.getElementById('date-button-sidebar');
  if (dateButton) {
    dateButton.setAttribute('aria-expanded', 'false');
  }
  if (dateButtonSidebar) {
    dateButtonSidebar.setAttribute('aria-expanded', 'false');
  }
}

export function initializeSidebarDate() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const todayStr = `${year}-${month}-${day}`;

  const dateInput = document.getElementById('date');
  const sidebarDateInput = document.getElementById('sidebar-date-input');

  if (dateInput) {
    dateInput.value = todayStr;
  }
  if (sidebarDateInput) {
    sidebarDateInput.value = todayStr;
  }

  updateSidebarDateDisplay(todayStr);
  state.selectedRaceDate = todayStr;
}

export function updateSidebarDate() {
  const dateInput = document.getElementById('sidebar-date-input');
  const mainDateInput = document.getElementById('date');

  if (!dateInput) return;

  const selectedDate = dateInput.value;
  if (!selectedDate) return;

  if (mainDateInput) {
    mainDateInput.value = selectedDate;
  }

  updateSidebarDateDisplay(selectedDate);
  state.selectedRaceDate = selectedDate;

  window.showMessage(`Race date set to ${formatDateForDisplay(selectedDate)}`);
}

export function setSidebarDateToday() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const todayStr = `${year}-${month}-${day}`;

  const sidebarDateInput = document.getElementById('sidebar-date-input');
  const mainDateInput = document.getElementById('date');

  if (sidebarDateInput) {
    sidebarDateInput.value = todayStr;
  }
  if (mainDateInput) {
    mainDateInput.value = todayStr;
  }

  updateSidebarDate();
}

export function updateSidebarDateDisplay(dateStr) {
  const dateText = document.getElementById('sidebar-date-text');
  const todayBtn = document.querySelector('.sidebar-date-today-btn');
  if (!dateText) return;

  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  const todayStr = `${year}-${month}-${day}`;

  if (dateStr === todayStr) {
    dateText.textContent = 'Today';
    if (todayBtn) {
      todayBtn.classList.add('hidden');
    }
  } else {
    dateText.textContent = dateStr;
    if (todayBtn) {
      todayBtn.classList.remove('hidden');
    }
  }
}

// TODO: Phase 4 - Replace with import from shared/utils/date.js
export function formatDateForDisplay(dateStr) {
  if (!dateStr) return 'No date';

  try {
    const [year, month, day] = dateStr.split('-');
    const displayMonth = parseInt(month);
    const displayDay = parseInt(day);
    const displayYear = parseInt(year);

    return `${displayMonth}/${displayDay}/${displayYear}`;
  } catch (_e) {
    return dateStr;
  }
}
