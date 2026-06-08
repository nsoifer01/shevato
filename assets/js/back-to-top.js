/* ==========================================================================
   Sitewide "Back to top" button. Standalone and dependency-free: works on a
   bare generated page that loads nothing else, as well as on the marketing
   pages and app pages.

   The button has two modes:

   WINDOW MODE (default, and the only mode on bare generated pages): the
   context is the window. The button shows once the window is scrolled past
   the threshold, sits in the bottom-right corner from the CSS, and a click
   scrolls the window to the top.

   MODAL MODE: any element carrying a `data-back-to-top` attribute is an
   opt-in scrollable container (a modal/overlay panel). The moment such a
   container is DISPLAYED (visible) the button enters modal mode for that
   container, REGARDLESS of how far the window behind it is scrolled. In
   modal mode:
     - Visibility tracks only the container: hidden until its scrollTop
       passes the threshold, hidden again below it. The window scroll
       position is ignored, so a scrolled page behind a freshly-opened modal
       does NOT show the button.
     - A click scrolls THAT container to the top.
     - The button is positioned inside the container's bounding rect
       (bottom-right corner, clamped on screen) via inline styles, so it
       reads as the modal's own control, and is lifted above the modal panel
       with an inline z-index. The inline styles are cleared on exit. The
       button stays a body child with position:fixed: the browser keeps it
       pinned while the panel scrolls (no per-scroll JS repositioning, no
       jitter); its clicks are kept from leaking to app backdrop /
       outside-click handlers by stopPropagation on every gesture phase.

   Tie-break when several opted-in containers are visible at once: the one
   with the greatest scrollTop wins (it is the one the user is actively
   reading); ties (e.g. all freshly opened at the top) fall back to the last
   in document order, which is the most recently appended / topmost modal.

   Open/close cannot rely on scroll events alone (closing a modal fires no
   scroll), so a MutationObserver on style/class/hidden across the body
   schedules the same rAF-throttled update.

   Hidden state is the `hidden` attribute (out of tab order and hidden from
   assistive tech); the visible state adds `back-to-top--visible`. Click
   scrolls smooth, or instant under `prefers-reduced-motion: reduce`.
   ========================================================================== */
(function() {
  'use strict';

  // Show/hide use SEPARATE thresholds (hysteresis): the button appears once
  // scrolled past SHOW_THRESHOLD and only disappears below the lower
  // HIDE_THRESHOLD. A single threshold made the button flicker (toggle every
  // frame) when a momentum scroll or URL-bar resize hovered right at the line.
  var SHOW_THRESHOLD = 400;
  var HIDE_THRESHOLD = 320;
  var EDGE_GAP = 16;       // px gap between the button and the modal rect edge
  var MODAL_Z_INDEX = 11001; // above apps' modal panels (z up to 11000)
  // While a finger/pointer is pressing the button (and briefly after release,
  // covering the synthesized click), the hide path is suppressed so a scroll
  // event firing mid-gesture cannot set the button display:none and make the
  // tap fall through to whatever is behind it. ~400ms covers the touch->click
  // delay on slow devices.
  var GESTURE_HOLD_MS = 400;

  function prefersReducedMotion() {
    return !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function isVisible(el) {
    // offsetParent is null for display:none (covers the `hidden` attribute
    // and CSS display:none modals). position:fixed elements have a null
    // offsetParent even when shown, so fall back to a rect check.
    if (el.offsetParent !== null) {
      return true;
    }
    var rect = el.getBoundingClientRect();
    return rect.width > 0 || rect.height > 0;
  }

  function init() {
    if (document.querySelector('.back-to-top')) {
      return;
    }

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'back-to-top';
    button.setAttribute('aria-label', 'Back to top');
    button.hidden = true;
    button.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path d="M12 19V5M5 12l7-7 7 7"/></svg>';
    document.body.appendChild(button);

    // The container currently driving modal mode, or null for window mode.
    var modalContainer = null;

    // True while the button is being pressed (and for GESTURE_HOLD_MS after
    // release). Suppresses hide() so a scroll event firing between touchstart
    // and the synthesized click cannot remove the button from under the finger.
    var gestureActive = false;
    var gestureReleaseTimer = null;

    // Pick the visible opted-in container that should own modal mode, or
    // null if none are visible (window mode). Greatest scrollTop wins; ties
    // fall back to the last visible container in document order.
    function findModalContainer() {
      var containers = document.querySelectorAll('[data-back-to-top]');
      var best = null;
      var bestScroll = -1;
      for (var i = 0; i < containers.length; i++) {
        var el = containers[i];
        if (!isVisible(el)) {
          continue;
        }
        // >= so a later (more recently opened / topmost) container wins ties.
        if (el.scrollTop >= bestScroll) {
          best = el;
          bestScroll = el.scrollTop;
        }
      }
      return best;
    }

    function windowScrolled() {
      return window.pageYOffset || document.documentElement.scrollTop || document.body.scrollTop || 0;
    }

    function show() {
      if (button.hidden) {
        button.hidden = false;
        window.requestAnimationFrame(function() {
          button.classList.add('back-to-top--visible');
        });
      }
    }

    function hide() {
      // Never yank the button out from under an in-progress tap: a scroll
      // crossing the threshold mid-gesture would otherwise set display:none
      // and the click would retarget to the element behind.
      if (gestureActive) {
        return;
      }
      if (!button.hidden) {
        button.classList.remove('back-to-top--visible');
        button.hidden = true;
      }
    }

    // Anchor the button to the bottom-right of the container's rect, lifted
    // above the modal. Clamp so it stays on screen on small viewports. The
    // values are stable while the panel scrolls (the panel itself does not
    // move), so the change-guards below make this a no-op on the scroll
    // path: no per-frame style writes, no jitter, and no MutationObserver
    // feedback loop (the button is inside the observed subtree).
    function positionInModal(container) {
      var rect = container.getBoundingClientRect();
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var vh = window.innerHeight || document.documentElement.clientHeight;

      var right = vw - rect.right + EDGE_GAP;
      var bottom = vh - rect.bottom + EDGE_GAP;
      if (right < EDGE_GAP) { right = EDGE_GAP; }
      if (bottom < EDGE_GAP) { bottom = EDGE_GAP; }

      var nextRight = right + 'px';
      var nextBottom = bottom + 'px';
      if (button.style.right !== nextRight) { button.style.right = nextRight; }
      if (button.style.bottom !== nextBottom) { button.style.bottom = nextBottom; }
      if (button.style.zIndex !== String(MODAL_Z_INDEX)) { button.style.zIndex = String(MODAL_Z_INDEX); }
    }

    // Return to window mode: drop the inline styles so the CSS corner
    // position and base z-index apply again.
    function clearModalPosition() {
      if (button.style.right !== '') { button.style.right = ''; }
      if (button.style.bottom !== '') { button.style.bottom = ''; }
      if (button.style.zIndex !== '') { button.style.zIndex = ''; }
    }

    var ticking = false;
    function update() {
      ticking = false;

      modalContainer = findModalContainer();

      if (modalContainer) {
        // Modal mode: visibility and position track the container only.
        // Hysteresis: show past SHOW_THRESHOLD, hide only below HIDE_THRESHOLD;
        // in the band between, keep the current state (no flicker).
        var mTop = modalContainer.scrollTop;
        if (mTop > SHOW_THRESHOLD) {
          positionInModal(modalContainer);
          show();
        } else if (mTop < HIDE_THRESHOLD) {
          hide();
          clearModalPosition();
        } else if (!button.hidden) {
          // Stay visible inside the band; keep the anchor fresh.
          positionInModal(modalContainer);
        }
      } else {
        // Window mode: today's behavior, with the same hysteresis band.
        clearModalPosition();
        var wTop = windowScrolled();
        if (wTop > SHOW_THRESHOLD) {
          show();
        } else if (wTop < HIDE_THRESHOLD) {
          hide();
        }
      }
    }

    function onScroll() {
      if (!ticking) {
        ticking = true;
        window.requestAnimationFrame(update);
      }
    }

    // App-level "click outside to close" handlers (modal backdrops, popovers)
    // often listen on document/window or at the capture phase. The button is a
    // body child overlaying the page, so its clicks must not leak to them, or
    // a tap on the button closes the modal it lives in. Swallow propagation on
    // the button for every gesture phase such handlers commonly use.
    function swallow(e) {
      e.stopPropagation();
    }

    // The scroll-to-top action, shared by the touch/pointer activation and the
    // mouse click path.
    function scrollToTop() {
      var behavior = prefersReducedMotion() ? 'auto' : 'smooth';
      // Recompute the context at activation time rather than trusting the
      // cached modalContainer: closing a modal fires no scroll event, so the
      // cache can point at a now-hidden container and the action would "scroll"
      // an invisible element while the page stays put.
      var target = findModalContainer();
      if (target) {
        if (typeof target.scrollTo === 'function') {
          target.scrollTo({ top: 0, behavior: behavior });
        } else {
          target.scrollTop = 0;
        }
      } else {
        window.scrollTo({ top: 0, behavior: behavior });
        // The window helper reports a scrolled state from the document element
        // OR the body (some app states make BODY the scroller, e.g. fh2h with
        // its desktop sidebar open: body.sidebar-open { overflow:hidden } turns
        // the body into the scroll context). window.scrollTo cannot move a
        // scrolled body/documentElement in those states, so the button would
        // SHOW (from body.scrollTop) yet the action would do nothing. Scroll
        // whatever actually holds the offset back to the top as well.
        if (document.body.scrollTop > 0) {
          if (typeof document.body.scrollTo === 'function') {
            document.body.scrollTo({ top: 0, behavior: behavior });
          } else {
            document.body.scrollTop = 0;
          }
        }
        if (document.documentElement.scrollTop > 0) {
          if (typeof document.documentElement.scrollTo === 'function') {
            document.documentElement.scrollTo({ top: 0, behavior: behavior });
          } else {
            document.documentElement.scrollTop = 0;
          }
        }
      }
      // Re-sync visibility shortly after: if the action was a no-op (stale
      // context, page already at top), the button should still hide.
      window.setTimeout(update, 300);
    }

    // Touch/pen position tracking so we only activate on a TAP (finger came
    // down and up on the button without a scrolling drag), not on a scroll
    // gesture that happened to start on the button.
    var SCROLL_TOLERANCE = 10; // px of movement still counted as a tap
    var startX = 0, startY = 0, moved = false;

    // Mark a gesture as in-progress on press, so a scroll event firing before
    // activation cannot hide the button (see hide()). Release is deferred by
    // GESTURE_HOLD_MS so the button stays put through the touch->click delay;
    // the next update() after that re-evaluates visibility normally.
    function beginGesture(e) {
      e.stopPropagation();
      gestureActive = true;
      moved = false;
      var pt = (e.touches && e.touches[0]) ? e.touches[0] : e;
      startX = pt.clientX || 0;
      startY = pt.clientY || 0;
      if (gestureReleaseTimer) {
        window.clearTimeout(gestureReleaseTimer);
        gestureReleaseTimer = null;
      }
    }
    function trackMove(e) {
      var pt = (e.touches && e.touches[0]) ? e.touches[0] : e;
      if (Math.abs((pt.clientX || 0) - startX) > SCROLL_TOLERANCE ||
          Math.abs((pt.clientY || 0) - startY) > SCROLL_TOLERANCE) {
        moved = true;
      }
    }
    function scheduleRelease() {
      if (gestureReleaseTimer) {
        window.clearTimeout(gestureReleaseTimer);
      }
      gestureReleaseTimer = window.setTimeout(function() {
        gestureActive = false;
        gestureReleaseTimer = null;
        onScroll();
      }, GESTURE_HOLD_MS);
    }
    button.addEventListener('pointerdown', beginGesture);
    button.addEventListener('mousedown', swallow);
    button.addEventListener('touchstart', beginGesture, { passive: true });
    button.addEventListener('pointermove', trackMove, { passive: true });
    button.addEventListener('touchmove', trackMove, { passive: true });
    button.addEventListener('pointercancel', function(e) { e.stopPropagation(); scheduleRelease(); });

    // Touch is the authoritative activation path on phones. We act on touchend
    // and call preventDefault() so the browser does NOT synthesize the trailing
    // ~300ms-delayed `click`. That delayed click is the bug: by the time it
    // fires, a scroll event may have hidden the button (display:none) and the
    // click retargets to whatever is behind it. Acting on touchend and killing
    // the synthesized click makes the tap land deterministically and removes
    // any possibility of fall-through. The listener is non-passive so
    // preventDefault is honored.
    button.addEventListener('touchend', function(e) {
      e.stopPropagation();
      if (!moved) {
        e.preventDefault(); // cancels the synthesized click -> no fall-through
        scrollToTop();
      }
      scheduleRelease();
    }, { passive: false });
    button.addEventListener('touchcancel', function() { scheduleRelease(); });

    // Pen: Pointer Events provide a clean up event with no synthesized-click
    // delay quirk; activate here. Mouse falls through to the click handler so
    // desktop behavior is byte-for-byte the prior behavior.
    button.addEventListener('pointerup', function(e) {
      e.stopPropagation();
      if (e.pointerType === 'pen' && !moved) {
        scrollToTop();
      }
      scheduleRelease();
    });

    button.addEventListener('click', function(e) {
      e.stopPropagation();
      scrollToTop();
    });

    // Capture phase so scroll events from opt-in containers (which do not
    // bubble) are observed without binding to each one, even when added to
    // the DOM later.
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll, { passive: true });

    // Modals open/close by toggling style/class/hidden, and closing fires no
    // scroll event. A cheap MutationObserver reuses the throttled update path
    // so the button leaves/enters modal mode promptly. On a bare page with no
    // opted-in containers this still fires occasionally but update() is cheap.
    if (typeof MutationObserver === 'function') {
      // Ignore mutations whose only targets are the button itself: in modal
      // mode the button lives in the observed subtree and we rewrite its
      // inline styles every frame, which would otherwise loop back through
      // onScroll -> update -> rewrite endlessly.
      var observer = new MutationObserver(function(records) {
        for (var i = 0; i < records.length; i++) {
          if (records[i].target !== button) {
            onScroll();
            return;
          }
        }
      });
      observer.observe(document.body, {
        attributes: true,
        attributeFilter: ['style', 'class', 'hidden'],
        subtree: true
      });
    }

    update();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
