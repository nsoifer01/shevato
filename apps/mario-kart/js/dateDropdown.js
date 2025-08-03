// Date Dropdown Enhancement - Close on select and display date
(function() {
    let dateButton = null;
    let dateInput = null;
    let dateDropdown = null;
    
    // Initialize on DOM load
    document.addEventListener('DOMContentLoaded', initDateDropdown);
    
    function initDateDropdown() {
        // Find elements
        dateButton = document.getElementById('date-button');
        dateInput = document.getElementById('date');
        dateDropdown = document.getElementById('calendar-dropdown');
        
        if (!dateButton || !dateInput || !dateDropdown) {
            console.warn('Calendar dropdown elements not found');
            return;
        }
        
        // Also find mobile date button
        const mobileDateButton = document.querySelector('.mobile-menu-panel .date-btn');
        if (mobileDateButton) {
            // Store reference for updates
            window.mobileDateButton = mobileDateButton;
        }
        
        // Add change event listener to date input
        dateInput.addEventListener('change', handleDateChange);
        
        // Add focus event listener to date input to open calendar when manually focused
        dateInput.addEventListener('focus', function(e) {
            if (!dateDropdown.classList.contains('open')) {
                // Open the dropdown when input is focused
                dateDropdown.classList.add('open');
                dateButton.setAttribute('aria-expanded', 'true');
                
                // Position the dropdown relative to the button
                const rect = dateButton.getBoundingClientRect();
                dateDropdown.style.position = 'fixed';
                dateDropdown.style.top = (rect.bottom + 5) + 'px';
                dateDropdown.style.left = rect.left + 'px';
                
                // Add flag to prevent immediate closing
                dateDropdown.setAttribute('data-just-opened', 'true');
                setTimeout(() => {
                    dateDropdown.removeAttribute('data-just-opened');
                }, 100);
            }
        });
        
        // Add click event listener to date input to open native calendar picker
        dateInput.addEventListener('click', function(e) {
            e.stopPropagation();
            // The native calendar picker will open automatically on click for date inputs
        });
        
        // Don't override the onclick, just ensure the dropdown behavior works
        // The toggleDateWidget function in main.js already handles everything we need
        
        // Initialize button text with current date
        updateButtonText();
        
        // Listen for outside clicks to close dropdown
        document.addEventListener('click', function(e) {
            // Check if dropdown was just opened (prevent immediate closing)
            if (dateDropdown.hasAttribute('data-just-opened')) {
                return;
            }
            
            if (dateDropdown.classList.contains('open')) {
                // Check if click is outside the button, dropdown, and date input
                if (!dateButton.contains(e.target) && 
                    !dateDropdown.contains(e.target) && 
                    !dateInput.contains(e.target) && 
                    e.target !== dateInput) {
                    dateDropdown.classList.remove('open');
                    dateButton.setAttribute('aria-expanded', 'false');
                }
            }
            updateButtonText();
        });
        
        // Prevent clicks inside the dropdown from bubbling up
        dateDropdown.addEventListener('click', function(e) {
            e.stopPropagation();
        });
        
        // Also close on escape key
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Escape' && dateDropdown.classList.contains('open')) {
                dateDropdown.classList.remove('open');
                dateButton.setAttribute('aria-expanded', 'false');
                dateButton.focus(); // Return focus to the button
            }
        });
    }
    
    // Format date for display (now using YYYY-MM-DD format)
    function formatDateForButton(dateString) {
        if (!dateString) return '📅 Set Date';
        
        try {
            // Simply return the date in YYYY-MM-DD format
            return `📅 ${dateString}`;
        } catch (e) {
            console.error('Error formatting date:', e);
            return '📅 Set Date';
        }
    }
    
    // Update button text with selected date
    function updateButtonText() {
        if (!dateButton || !dateInput) return;
        
        const selectedDate = dateInput.value;
        const formattedDate = formatDateForButton(selectedDate);
        
        // Update main button
        dateButton.innerHTML = formattedDate;
        
        // Add visual indication when date is selected
        if (selectedDate) {
            dateButton.style.fontWeight = '600';
            dateButton.title = `Selected date: ${formattedDate.replace('📅 ', '')}`;
        } else {
            dateButton.style.fontWeight = 'normal';
            dateButton.title = 'Set race date';
        }
        
        // Update mobile button if it exists
        if (window.mobileDateButton) {
            if (selectedDate) {
                // Show abbreviated date on mobile to save space
                const date = new Date(selectedDate + 'T00:00:00');
                const mobileFormat = new Intl.DateTimeFormat('en-US', { 
                    month: 'short', 
                    day: 'numeric' 
                }).format(date);
                window.mobileDateButton.innerHTML = `📅 ${mobileFormat}`;
                window.mobileDateButton.title = formattedDate.replace('📅 ', '');
            } else {
                window.mobileDateButton.innerHTML = '📅';
                window.mobileDateButton.title = 'Date';
            }
        }
    }
    
    // Handle date selection
    function handleDateChange(e) {
        // Update button text immediately
        updateButtonText();
        
        // Close the dropdown
        if (dateDropdown && dateDropdown.classList.contains('open')) {
            dateDropdown.classList.remove('open');
            dateButton.setAttribute('aria-expanded', 'false');
        }
        
        // Optional: Show a subtle confirmation
        if (dateButton) {
            dateButton.style.transform = 'scale(0.95)';
            setTimeout(() => {
                dateButton.style.transform = 'scale(1)';
            }, 100);
        }
    }
    
    // Export functions for external use if needed
    window.updateDateButtonText = updateButtonText;
    window.formatDateForButton = formatDateForButton;
})();