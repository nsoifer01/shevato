// Player Icon Manager - Handles storage and retrieval of player icons
(function() {
    const STORAGE_KEY = 'marioKartPlayerIcons';
    const MAX_ICON_SIZE = 1024 * 1024; // 1MB
    const ALLOWED_FORMATS = ['image/png', 'image/jpeg', 'image/jpg', 'image/svg+xml'];
    
    // Cache for player icons
    let iconCache = {};
    
    // Initialize and load existing icons
    function init() {
        loadIcons();
    }
    
    // Load icons from localStorage
    function loadIcons() {
        try {
            const stored = localStorage.getItem(STORAGE_KEY);
            if (stored) {
                iconCache = JSON.parse(stored);
            }
        } catch (e) {
            console.error('Error loading player icons:', e);
            iconCache = {};
        }
    }
    
    // Save icons to localStorage
    function saveIcons() {
        try {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(iconCache));
        } catch (e) {
            console.error('Error saving player icons:', e);
            // Handle quota exceeded error
            if (e.name === 'QuotaExceededError') {
                alert('Storage quota exceeded. Please remove some icons.');
            }
        }
    }
    
    // Set icon for a player
    function setIcon(playerKey, base64Data) {
        iconCache[playerKey] = base64Data;
        saveIcons();
        notifyListeners(playerKey);
    }
    
    // Get icon for a player
    function getIcon(playerKey) {
        return iconCache[playerKey] || null;
    }
    
    // Remove icon for a player
    function removeIcon(playerKey) {
        delete iconCache[playerKey];
        saveIcons();
        notifyListeners(playerKey);
    }
    
    // Get all icons
    function getAllIcons() {
        return { ...iconCache };
    }
    
    // Clear all icons
    function clearAllIcons() {
        iconCache = {};
        saveIcons();
        notifyAllListeners();
    }
    
    // Validate image file
    function validateImageFile(file) {
        if (!file) {
            return { valid: false, error: 'No file provided' };
        }
        
        if (!ALLOWED_FORMATS.includes(file.type)) {
            return { valid: false, error: 'Invalid file format. Please use PNG, JPG, or SVG.' };
        }
        
        if (file.size > MAX_ICON_SIZE) {
            return { valid: false, error: 'File too large. Maximum size is 1MB.' };
        }
        
        return { valid: true };
    }
    
    // Convert file to base64
    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }
    
    // Process uploaded file
    async function processIconUpload(playerKey, file) {
        const validation = validateImageFile(file);
        if (!validation.valid) {
            throw new Error(validation.error);
        }
        
        try {
            const base64Data = await fileToBase64(file);
            setIcon(playerKey, base64Data);
            return base64Data;
        } catch (e) {
            throw new Error('Failed to process image: ' + e.message);
        }
    }
    
    // Get default avatar for player
    function getDefaultAvatar(playerKey, playerName) {
        const colors = ['#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4'];
        const playerNum = parseInt(playerKey.replace('player', '')) - 1;
        const color = colors[playerNum % colors.length];
        const initial = (playerName || playerKey).charAt(0).toUpperCase();
        
        // Return SVG data URL for default avatar
        const svg = `
            <svg width="40" height="40" viewBox="0 0 40 40" xmlns="http://www.w3.org/2000/svg">
                <circle cx="20" cy="20" r="20" fill="${color}"/>
                <text x="20" y="20" text-anchor="middle" dominant-baseline="central" 
                      fill="white" font-family="Arial, sans-serif" font-size="18" font-weight="bold">
                    ${initial}
                </text>
            </svg>
        `;
        
        return `data:image/svg+xml;base64,${btoa(svg)}`;
    }
    
    // Listener management
    const listeners = new Set();
    
    function subscribe(callback) {
        listeners.add(callback);
        return () => listeners.delete(callback);
    }
    
    function notifyListeners(playerKey) {
        listeners.forEach(callback => {
            try {
                callback(playerKey);
            } catch (e) {
                console.error('Error in icon listener:', e);
            }
        });
    }
    
    function notifyAllListeners() {
        ['player1', 'player2', 'player3', 'player4'].forEach(playerKey => {
            notifyListeners(playerKey);
        });
    }
    
    // Initialize on load
    init();
    
    // Export API
    window.PlayerIconManager = {
        getIcon,
        setIcon,
        removeIcon,
        getAllIcons,
        clearAllIcons,
        processIconUpload,
        getDefaultAvatar,
        subscribe,
        validateImageFile,
        fileToBase64
    };
})();