// Pagination Manager for Race History Table
const PaginationManager = (function() {
    // State variables
    let currentPage = 1;
    let rowsPerPage = 10; // Default rows per page
    let totalRaces = 0;
    let paginatedRaces = [];
    
    // Available page size options
    const pageSizeOptions = [10, 25, 50];
    
    // Initialize pagination
    function init() {
        currentPage = 1;
        const savedPageSize = localStorage.getItem('raceHistoryPageSize');
        if (savedPageSize && pageSizeOptions.includes(parseInt(savedPageSize))) {
            rowsPerPage = parseInt(savedPageSize);
        }
    }
    
    // Calculate total pages
    function getTotalPages() {
        return Math.ceil(totalRaces / rowsPerPage);
    }
    
    // Get paginated subset of races
    function getPaginatedRaces(races) {
        totalRaces = races.length;
        const startIndex = (currentPage - 1) * rowsPerPage;
        const endIndex = startIndex + rowsPerPage;
        paginatedRaces = races.slice(startIndex, endIndex);
        return paginatedRaces;
    }
    
    // Navigate to specific page
    function goToPage(page) {
        const totalPages = getTotalPages();
        if (page >= 1 && page <= totalPages) {
            currentPage = page;
            if (window.updateDisplay) {
                window.updateDisplay();
            }
        }
    }
    
    // Navigate to next page
    function nextPage() {
        if (currentPage < getTotalPages()) {
            currentPage++;
            if (window.updateDisplay) {
                window.updateDisplay();
            }
        }
    }
    
    // Navigate to previous page
    function previousPage() {
        if (currentPage > 1) {
            currentPage--;
            if (window.updateDisplay) {
                window.updateDisplay();
            }
        }
    }
    
    // Change rows per page
    function setRowsPerPage(newSize) {
        if (pageSizeOptions.includes(newSize)) {
            rowsPerPage = newSize;
            currentPage = 1; // Reset to first page
            localStorage.setItem('raceHistoryPageSize', newSize);
            if (window.updateDisplay) {
                window.updateDisplay();
            }
        }
    }
    
    // Create pagination controls HTML
    function createPaginationControls() {
        const totalPages = getTotalPages();
        
        if (totalRaces === 0) {
            return ''; // No pagination needed
        }
        
        let html = `
        <div class="pagination-container">
            <div class="pagination-info">
                Showing ${((currentPage - 1) * rowsPerPage) + 1}-${Math.min(currentPage * rowsPerPage, totalRaces)} of ${totalRaces} races
            </div>
            
            <div class="pagination-controls">
                <button class="pagination-btn pagination-prev" 
                        onclick="PaginationManager.previousPage()" 
                        ${currentPage === 1 ? 'disabled' : ''}
                        title="Previous page">
                    ←
                </button>
                
                <div class="pagination-pages">
        `;
        
        // Generate page number buttons
        const pageNumbers = generatePageNumbers(currentPage, totalPages);
        pageNumbers.forEach(pageNum => {
            if (pageNum === '...') {
                html += `<span class="pagination-ellipsis">...</span>`;
            } else {
                html += `
                    <button class="pagination-btn pagination-page ${pageNum === currentPage ? 'active' : ''}" 
                            onclick="PaginationManager.goToPage(${pageNum})"
                            title="Go to page ${pageNum}">
                        ${pageNum}
                    </button>
                `;
            }
        });
        
        html += `
                </div>
                
                <button class="pagination-btn pagination-next" 
                        onclick="PaginationManager.nextPage()" 
                        ${currentPage === totalPages ? 'disabled' : ''}
                        title="Next page">
                    →
                </button>
            </div>
            
            <div class="pagination-size">
                <label for="page-size">Rows per page:</label>
                <select id="page-size" onchange="PaginationManager.setRowsPerPage(parseInt(this.value))">
        `;
        
        pageSizeOptions.forEach(size => {
            html += `<option value="${size}" ${size === rowsPerPage ? 'selected' : ''}>${size}</option>`;
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
            const rangeWithDots = [];
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
    function reset() {
        currentPage = 1;
    }
    
    // Get current state
    function getState() {
        return {
            currentPage,
            rowsPerPage,
            totalRaces,
            totalPages: getTotalPages()
        };
    }
    
    // Public API
    return {
        init,
        getPaginatedRaces,
        goToPage,
        nextPage,
        previousPage,
        setRowsPerPage,
        createPaginationControls,
        reset,
        getState
    };
})();

// Initialize on page load
document.addEventListener('DOMContentLoaded', function() {
    PaginationManager.init();
});

// Make it globally accessible
window.PaginationManager = PaginationManager;