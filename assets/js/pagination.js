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

        // Load saved page size from localStorage. Wrapped because some
        // private-browsing contexts throw on access — failing here would
        // abort the whole instance and leave the table unpaginated.
        try {
            const savedPageSize = localStorage.getItem(finalConfig.localStorageKey);
            if (savedPageSize && finalConfig.pageSizeOptions.includes(parseInt(savedPageSize))) {
                instances[instanceId].rowsPerPage = parseInt(savedPageSize);
            }
        } catch (_) {
            // localStorage unavailable — fall back to the default rowsPerPage.
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
            try {
                localStorage.setItem(instance.config.localStorageKey, newSize);
            } catch (_) {
                // localStorage unavailable (e.g. private browsing) —
                // the new size still applies for this session.
            }
            if (instance.config.updateCallback) {
                instance.config.updateCallback();
            }
        }
    }

    // Escape an attribute value so a hostile instanceId can't break out
    // of the surrounding double-quoted attribute. Only `"` and `&` matter
    // for an attribute context.
    function escapeAttr(value) {
        return String(value).replace(/&/g, '&amp;').replace(/"/g, '&quot;');
    }

    // Create pagination controls HTML.
    //
    // Buttons and the page-size <select> declare their intent through
    // `data-action` attributes (`prev`, `next`, `page`, `size`) instead of
    // inline `onclick` / `onchange` handlers. A single delegated listener
    // (installed once below) reads `data-action` and the enclosing
    // container's `data-pagination-instance` to dispatch into the API.
    // Avoiding inline handlers means this markup works under a strict
    // CSP without `'unsafe-inline'` / `'unsafe-hashes'`.
    function createPaginationControls(instanceId) {
        const instance = getInstance(instanceId);
        const totalPages = getTotalPages(instanceId);

        if (instance.totalItems === 0) {
            return ''; // No pagination needed
        }

        const safeId = escapeAttr(instanceId);
        let html = `
        <div class="pagination-container" data-pagination-instance="${safeId}">
            <div class="pagination-info">
                Showing ${((instance.currentPage - 1) * instance.rowsPerPage) + 1}-${Math.min(instance.currentPage * instance.rowsPerPage, instance.totalItems)} of ${instance.totalItems}
            </div>

            <div class="pagination-controls">
                <button type="button" class="pagination-btn pagination-prev"
                        data-action="prev"
                        ${instance.currentPage === 1 ? 'disabled' : ''}
                        title="Previous page" aria-label="Previous page">
                    ←
                </button>

                <div class="pagination-pages">
        `;

        // Generate page number buttons
        const pageNumbers = generatePageNumbers(instance.currentPage, totalPages);
        pageNumbers.forEach(pageNum => {
            if (pageNum === '...') {
                html += `<span class="pagination-ellipsis" aria-hidden="true">...</span>`;
            } else {
                const isActive = pageNum === instance.currentPage;
                html += `
                    <button type="button" class="pagination-btn pagination-page ${isActive ? 'active' : ''}"
                            data-action="page" data-page="${pageNum}"
                            ${isActive ? 'aria-current="page"' : ''}
                            title="Go to page ${pageNum}" aria-label="Go to page ${pageNum}">
                        ${pageNum}
                    </button>
                `;
            }
        });

        html += `
                </div>

                <button type="button" class="pagination-btn pagination-next"
                        data-action="next"
                        ${instance.currentPage === totalPages ? 'disabled' : ''}
                        title="Next page" aria-label="Next page">
                    →
                </button>
            </div>

            <div class="pagination-size">
                <label for="page-size-${safeId}">Rows per page:</label>
                <select id="page-size-${safeId}" data-action="size">
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

// Install delegated click + change handlers exactly once. Pagination
// containers may be re-rendered many times by the host app — putting
// the listeners on `document` keeps them alive across re-renders and
// removes the need for inline `onclick` / `onchange` attributes.
(function installPaginationDelegation() {
    if (typeof document === 'undefined' || document.__paginationDelegationInstalled) {
        return;
    }
    document.__paginationDelegationInstalled = true;

    function findInstance(target) {
        const container = target.closest('[data-pagination-instance]');
        return container ? container.getAttribute('data-pagination-instance') : null;
    }

    document.addEventListener('click', function (event) {
        const trigger = event.target.closest('.pagination-container [data-action]');
        if (!trigger || trigger.disabled) return;
        const instanceId = findInstance(trigger);
        if (!instanceId) return;

        switch (trigger.getAttribute('data-action')) {
            case 'prev':
                GlobalPaginationManager.previousPage(instanceId);
                break;
            case 'next':
                GlobalPaginationManager.nextPage(instanceId);
                break;
            case 'page': {
                const page = parseInt(trigger.getAttribute('data-page'), 10);
                if (Number.isFinite(page)) {
                    GlobalPaginationManager.goToPage(instanceId, page);
                }
                break;
            }
            default:
                break;
        }
    });

    document.addEventListener('change', function (event) {
        const select = event.target.closest('.pagination-container select[data-action="size"]');
        if (!select) return;
        const instanceId = findInstance(select);
        if (!instanceId) return;
        const size = parseInt(select.value, 10);
        if (Number.isFinite(size)) {
            GlobalPaginationManager.setRowsPerPage(instanceId, size);
        }
    });
})();
