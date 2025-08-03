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

  // jQuery specific fix for touch events
  if (typeof jQuery !== 'undefined') {
    // Store original jQuery.event.add
    var originalEventAdd = jQuery.event.add;
    
    // Override jQuery event handling to support passive events
    jQuery.event.add = function(elem, types, handler, data, selector) {
      var handleObj = handler;
      var passiveEvents = ['touchstart', 'touchmove', 'wheel', 'mousewheel'];
      
      // Check if this is a touch event that should be passive
      if (types && passiveEvents.indexOf(types) !== -1) {
        // For jQuery 3.x, we need to handle this differently
        if (jQuery.event.special[types]) {
          var originalSetup = jQuery.event.special[types].setup;
          jQuery.event.special[types].setup = function() {
            this.addEventListener(types, function() {}, { passive: true });
            if (originalSetup) {
              return originalSetup.apply(this, arguments);
            }
          };
        }
      }
      
      return originalEventAdd.apply(this, arguments);
    };
  }
})();