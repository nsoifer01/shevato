// Global Pagination Manager
const GlobalPaginationManager = (function() {
    // Configuration object for each pagination instance
    const instances = {};
    
    // Default configuration
    const defaultConfig = {
        rowsPerPage: 10,
        pageSizeOptions: [10, 25, 50],
        localStorageKey: 'paginationPageSize',
        updateCallback: null
    };
    
    // Create a new pagination instance
    function createInstance(instanceId, config = {}) {
        const finalConfig = { ...defaultConfig, ...config };
        
        instances[instanceId] = {
            currentPage: 1,
            rowsPerPage: finalConfig.rowsPerPage,
            totalItems: 0,
            paginatedItems: [],
            config: finalConfig
        };
        
        // Load saved page size from localStorage
        const savedPageSize = localStorage.getItem(finalConfig.localStorageKey);
        if (savedPageSize && finalConfig.pageSizeOptions.includes(parseInt(savedPageSize))) {
            instances[instanceId].rowsPerPage = parseInt(savedPageSize);
        }
        
        return instanceId;
    }
    
    // Get instance or create if doesn't exist
    function getInstance(instanceId) {
        if (!instances[instanceId]) {
            createInstance(instanceId);
        }
        return instances[instanceId];
    }
    
    // Calculate total pages for an instance
    function getTotalPages(instanceId) {
        const instance = getInstance(instanceId);
        return Math.ceil(instance.totalItems / instance.rowsPerPage);
    }
    
    // Get paginated subset of items
    function getPaginatedItems(instanceId, items) {
        const instance = getInstance(instanceId);
        instance.totalItems = items.length;
        const startIndex = (instance.currentPage - 1) * instance.rowsPerPage;
        const endIndex = startIndex + instance.rowsPerPage;
        instance.paginatedItems = items.slice(startIndex, endIndex);
        return instance.paginatedItems;
    }
    
    // Navigate to specific page
    function goToPage(instanceId, page) {
        const instance = getInstance(instanceId);
        const totalPages = getTotalPages(instanceId);
        if (page >= 1 && page <= totalPages) {
            instance.currentPage = page;
            if (instance.config.updateCallback) {
                instance.config.updateCallback();
            }
        }
    }
    
    // Navigate to next page
    function nextPage(instanceId) {
        const instance = getInstance(instanceId);
        if (instance.currentPage < getTotalPages(instanceId)) {
            instance.currentPage++;
            if (instance.config.updateCallback) {
                instance.config.updateCallback();
            }
        }
    }
    
    // Navigate to previous page
    function previousPage(instanceId) {
        const instance = getInstance(instanceId);
        if (instance.currentPage > 1) {
            instance.currentPage--;
            if (instance.config.updateCallback) {
                instance.config.updateCallback();
            }
        }
    }
    
    // Change rows per page
    function setRowsPerPage(instanceId, newSize) {
        const instance = getInstance(instanceId);
        if (instance.config.pageSizeOptions.includes(newSize)) {
            instance.rowsPerPage = newSize;
            instance.currentPage = 1; // Reset to first page
            localStorage.setItem(instance.config.localStorageKey, newSize);
            if (instance.config.updateCallback) {
                instance.config.updateCallback();
            }
        }
    }
    
    // Create pagination controls HTML
    function createPaginationControls(instanceId) {
        const instance = getInstance(instanceId);
        const totalPages = getTotalPages(instanceId);
        
        if (instance.totalItems === 0) {
            return ''; // No pagination needed
        }
        
        let html = `
        <div class="pagination-container">
            <div class="pagination-info">
                Showing ${((instance.currentPage - 1) * instance.rowsPerPage) + 1}-${Math.min(instance.currentPage * instance.rowsPerPage, instance.totalItems)} of ${instance.totalItems}
            </div>
            
            <div class="pagination-controls">
                <button class="pagination-btn pagination-prev" 
                        onclick="GlobalPaginationManager.previousPage('${instanceId}')" 
                        ${instance.currentPage === 1 ? 'disabled' : ''}
                        title="Previous page">
                    ←
                </button>
                
                <div class="pagination-pages">
        `;
        
        // Generate page number buttons
        const pageNumbers = generatePageNumbers(instance.currentPage, totalPages);
        pageNumbers.forEach(pageNum => {
            if (pageNum === '...') {
                html += `<span class="pagination-ellipsis">...</span>`;
            } else {
                html += `
                    <button class="pagination-btn pagination-page ${pageNum === instance.currentPage ? 'active' : ''}" 
                            onclick="GlobalPaginationManager.goToPage('${instanceId}', ${pageNum})"
                            title="Go to page ${pageNum}">
                        ${pageNum}
                    </button>
                `;
            }
        });
        
        html += `
                </div>
                
                <button class="pagination-btn pagination-next" 
                        onclick="GlobalPaginationManager.nextPage('${instanceId}')" 
                        ${instance.currentPage === totalPages ? 'disabled' : ''}
                        title="Next page">
                    →
                </button>
            </div>
            
            <div class="pagination-size">
                <label for="page-size-${instanceId}">Rows per page:</label>
                <select id="page-size-${instanceId}" onchange="GlobalPaginationManager.setRowsPerPage('${instanceId}', parseInt(this.value))">
        `;
        
        instance.config.pageSizeOptions.forEach(size => {
            html += `<option value="${size}" ${size === instance.rowsPerPage ? 'selected' : ''}>${size}</option>`;
        });
        
        html += `
                </select>
            </div>
        </div>
        `;
        
        return html;
    }
    
    // Generate page numbers to display (with ellipsis for large datasets)
    function generatePageNumbers(current, total) {
        const delta = 2; // Number of pages to show on each side of current
        const range = [];
        
        if (total <= 7) {
            // Show all pages if total is small
            for (let i = 1; i <= total; i++) {
                range.push(i);
            }
        } else {
            // Always show first page
            range.push(1);
            
            // Calculate range around current page
            const left = Math.max(2, current - delta);
            const right = Math.min(total - 1, current + delta);
            
            // Add ellipsis if needed on the left
            if (left > 2) {
                range.push('...');
            }
            
            // Add pages around current
            for (let i = left; i <= right; i++) {
                range.push(i);
            }
            
            // Add ellipsis if needed on the right
            if (right < total - 1) {
                range.push('...');
            }
            
            // Always show last page
            range.push(total);
        }
        
        return range;
    }
    
    // Reset pagination when data changes
    function reset(instanceId) {
        const instance = getInstance(instanceId);
        instance.currentPage = 1;
    }
    
    // Get current state
    function getState(instanceId) {
        const instance = getInstance(instanceId);
        return {
            currentPage: instance.currentPage,
            rowsPerPage: instance.rowsPerPage,
            totalItems: instance.totalItems,
            totalPages: getTotalPages(instanceId)
        };
    }
    
    // Update configuration for an instance
    function updateConfig(instanceId, newConfig) {
        const instance = getInstance(instanceId);
        instance.config = { ...instance.config, ...newConfig };
    }
    
    // Public API
    return {
        createInstance,
        getPaginatedItems,
        goToPage,
        nextPage,
        previousPage,
        setRowsPerPage,
        createPaginationControls,
        reset,
        getState,
        updateConfig
    };
})();

// Make it globally accessible
window.GlobalPaginationManager = GlobalPaginationManager;