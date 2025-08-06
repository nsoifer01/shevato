/**
 * Fix for passive event listeners warning
 * Makes touchstart and touchmove events passive where appropriate
 */
(function() {
  // Store the original addEventListener
  var originalAddEventListener = EventTarget.prototype.addEventListener;
  
  // Override addEventListener to add passive flag for touch events
  EventTarget.prototype.addEventListener = function(type, listener, options) {
    var passiveEvents = ['touchstart', 'touchmove', 'wheel', 'mousewheel'];
    
    if (passiveEvents.indexOf(type) !== -1) {
      // If options is not an object, convert it
      if (typeof options === 'boolean') {
        options = {
          capture: options,
          passive: true
        };
      } else if (!options) {
        options = {
          passive: true
        };
      } else if (typeof options === 'object' && options.passive === undefined) {
        // Add passive flag if not explicitly set
        options.passive = true;
      }
    }
    
    return originalAddEventListener.call(this, type, listener, options);
  };

  // jQuery-specific fix for passive touch events
  if (typeof jQuery !== 'undefined') {
    jQuery(document).ready(function($) {
      // Only add passive listeners for scroll-related events
      // Don't override jQuery methods as they might break functionality
      var passiveEvents = ['touchstart', 'touchmove', 'wheel', 'mousewheel'];
      
      passiveEvents.forEach(function(eventType) {
        // Add a passive dummy listener to satisfy browser requirements
        document.addEventListener(eventType, function() {
          // Empty function - just to register passive capability
        }, { passive: true });
      });
    });
  }
})();