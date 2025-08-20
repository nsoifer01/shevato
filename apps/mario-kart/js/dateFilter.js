let currentDateFilter = 'all';
let customStartDate = null;
let customEndDate = null;

function setDateFilter(filter) {
    currentDateFilter = filter;
    
    // Reset pagination when filter changes
    if (window.GlobalPaginationManager) {
        window.GlobalPaginationManager.reset('mario-kart-races');
    }

    // Update active button - use the passed event or find the button
    document.querySelectorAll('.filter-btn').forEach(btn => {
        btn.classList.remove('active');
    });

    // Find and activate the correct button based on onclick attribute
    const buttons = document.querySelectorAll('.filter-btn');
    buttons.forEach(btn => {
        const onclickAttr = btn.getAttribute('onclick');
        if (onclickAttr && onclickAttr.includes(`'${filter}'`)) {
            btn.classList.add('active');
        }
    });

    // Show/hide custom date range
    const customRange = document.getElementById('custom-date-range');
    if (customRange) {
        customRange.style.display = filter === 'custom' ? 'flex' : 'none';
        // Clear any error message when hiding custom range
        if (filter !== 'custom') {
            clearCustomDateError();
        }
    }

    // Gray out Activity button when on today filter
    const activityButton = document.querySelector('.toggle-btn[onclick*="activity"]');
    if (activityButton) {
        if (filter === 'today') {
            activityButton.style.background = '#6b7280';
            activityButton.style.cursor = 'not-allowed';
            activityButton.disabled = true;

            // If currently on activity view and switching to today filter, switch to stats view
            if (currentView === 'activity') {
                toggleView('stats');
            }
        } else {
            activityButton.style.background = '';
            activityButton.style.cursor = '';
            activityButton.disabled = false;
        }
    }

    showMessage(`Filter set to: ${filter === 'all' ? 'All Time' : filter === 'today' ? 'Today' : filter === 'week' ? 'Last 7 Days' : filter === 'month' ? 'Last 30 Days' : 'Custom Range'}`);

    if (filter !== 'custom') {
        updateDisplay();
    }
}

function showCustomDateError(message) {
    // Remove any existing error message
    clearCustomDateError();
    
    // Find the custom date range container
    const customRange = document.getElementById('custom-date-range');
    if (!customRange) return;
    
    // Create error message element
    const errorDiv = document.createElement('div');
    errorDiv.id = 'custom-date-error';
    errorDiv.style.cssText = `
        color: #ef4444;
        font-size: 0.875rem;
        margin-top: 8px;
        padding: 8px 12px;
        background: rgba(239, 68, 68, 0.1);
        border: 1px solid rgba(239, 68, 68, 0.2);
        border-radius: 6px;
        font-weight: 500;
    `;
    errorDiv.textContent = message;
    
    // Insert error message after the apply button
    const applyButton = customRange.querySelector('button');
    if (applyButton) {
        applyButton.insertAdjacentElement('afterend', errorDiv);
    }
}

function clearCustomDateError() {
    const existingError = document.getElementById('custom-date-error');
    if (existingError) {
        existingError.remove();
    }
}

function applyCustomDateFilter() {
    const startDate = document.getElementById('filter-start-date').value;
    const endDate = document.getElementById('filter-end-date').value;

    // Clear any existing error message
    clearCustomDateError();

    if (!startDate || !endDate) {
        showCustomDateError('Please select both start and end dates');
        return;
    }

    // Validate that start date is not after end date
    if (startDate > endDate) {
        showCustomDateError('Start date must be before end date');
        return;
    }

    customStartDate = startDate;
    customEndDate = endDate;
    updateDisplay();
    
    // Show success message
    showMessage(`Filter set to: ${startDate} to ${endDate}`);
}

function getFilteredRaces() {
    let filtered = races;
    // Get today's date in user's local timezone
    const today = new Date().toLocaleDateString('en-CA');

    switch (currentDateFilter) {
        case 'today':
            filtered = races.filter(race => race.date === today);
            // console.log(`Today filter: found ${filtered.length} races`);
            break;
        case 'week':
            const weekAgo = new Date();
            weekAgo.setDate(weekAgo.getDate() - 7);
            filtered = races.filter(race => new Date(race.date) >= weekAgo);
            // console.log(`Week filter: found ${filtered.length} races`);
            break;
        case 'month':
            const monthAgo = new Date();
            monthAgo.setDate(monthAgo.getDate() - 30);
            filtered = races.filter(race => new Date(race.date) >= monthAgo);
            // console.log(`Month filter: found ${filtered.length} races`);
            break;
        case 'custom':
            if (customStartDate && customEndDate) {
                filtered = races.filter(race =>
                    race.date >= customStartDate && race.date <= customEndDate
                );
                // console.log(`Custom filter: found ${filtered.length} races`);
            }
            break;
        default: // 'all'
            filtered = races;
            // console.log(`All filter: found ${filtered.length} races`);
    }

    return filtered;
}

// Export functions to global scope
window.setDateFilter = setDateFilter;
window.getFilteredRaces = getFilteredRaces;
