/**
 * 404 page redirect countdown.
 * Decrements the visible seconds value until it hits zero, then sends
 * the user to "/home.html". The element already carries
 * aria-live="polite", so screen readers announce each tick.
 *
 * Targets /home.html directly rather than "/" — the apex would otherwise
 * trigger a second hop through the apex-redirect script, costing one
 * extra navigation and history entry.
 *
 * Pulled out of 404.html so the page works under a strict CSP without
 * needing 'unsafe-inline' or a per-deploy script-hash.
 */
(function () {
  var el = document.getElementById('redirect-countdown');
  if (!el) return;

  var seconds = parseInt(el.textContent, 10);
  if (!Number.isFinite(seconds) || seconds <= 0) seconds = 5;

  var timer = setInterval(function () {
    seconds -= 1;
    if (seconds <= 0) {
      clearInterval(timer);
      window.location.href = '/home.html';
    } else {
      el.textContent = String(seconds);
    }
  }, 1000);
})();
