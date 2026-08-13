// Page scroll lock for modal overlays.
//
// THE RULE: an overlay with its own scrollable content locks the page under
// it; only the overlay scrolls until it closes. Any modal this app adds goes
// through these two functions rather than growing its own workaround.
//
// The mechanism is the fixed-body technique: on lock, the body is pinned at
// its current scroll offset (`position: fixed; top: -scrollY`), which freezes
// the page for every input method at once - wheel, trackpad, touch, keyboard,
// scrollbar - because the document simply stops being scrollable. On unlock
// the inline styles are restored to exactly what they were and the window is
// scrolled back to the recorded offset, so the user lands where they left.
// `overflow: hidden` alone is not used because iOS Safari ignores it for
// touch scrolling.
//
// The lock is reference-counted so two overlays (or a re-entrant open) cannot
// unlock each other early; the page unlocks only when the last holder
// releases. Pinning the body hides the page scrollbar, which would shift the
// content behind the overlay by the scrollbar's width, so that width is
// compensated with body padding for as long as the lock holds.
//
// Only inline styles on <body> are touched, and only while a modal is open.
// Nothing here styles shared chrome: the scoping contract concerns
// stylesheets; this is transient DOM state, faithfully restored.

let locks = 0;
let saved = null;

export function lockScroll() {
  locks += 1;
  if (locks > 1) return;

  const y = window.scrollY || window.pageYOffset || 0;
  const scrollbarGap = window.innerWidth - document.documentElement.clientWidth;
  const s = document.body.style;
  saved = {
    y,
    position: s.position,
    top: s.top,
    left: s.left,
    right: s.right,
    width: s.width,
    paddingRight: s.paddingRight,
  };

  s.position = 'fixed';
  s.top = `-${y}px`;
  s.left = '0';
  s.right = '0';
  s.width = '100%';
  if (scrollbarGap > 0) s.paddingRight = `${scrollbarGap}px`;
}

export function unlockScroll() {
  if (locks === 0) return;
  locks -= 1;
  if (locks > 0 || !saved) return;

  const s = document.body.style;
  s.position = saved.position;
  s.top = saved.top;
  s.left = saved.left;
  s.right = saved.right;
  s.width = saved.width;
  s.paddingRight = saved.paddingRight;
  window.scrollTo(0, saved.y);
  saved = null;
}

// For tests and diagnostics: is the page currently locked?
export function isScrollLocked() {
  return locks > 0;
}
