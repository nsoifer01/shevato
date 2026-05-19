'use strict';

// Shared footer used by every static page in this app. Inlined into the
// HTML at build time — no JS partial-include — so the cross-app links
// are visible to Googlebot and to JS-disabled visitors. Keep this in
// sync with apps/gym-tracker/scripts/render-footer.cjs.
function renderMoreFooter() {
  return `<footer class="page-footer">
    <nav class="footer-more" aria-label="More Shevato apps">
      <p class="footer-more-heading">More from Shevato</p>
      <ul>
        <li><a href="/apps/rising-seasons/"><strong>Rising Seasons</strong><span> · TV by episode-rating shape</span></a></li>
        <li><a href="/apps/gym-tracker/"><strong>Gym Tracker</strong><span> · workouts and strength progress</span></a></li>
        <li><a href="/apps/mario-kart/"><strong>Mario Kart Tracker</strong><span> · race tracker and stats</span></a></li>
        <li><a href="/apps/football-h2h/"><strong>Football H2H</strong><span> · head-to-head match tracker</span></a></li>
        <li><a href="/apps/maptap-rivals/"><strong>MapTap Rivals</strong><span> · daily MapTap.gg tracker</span></a></li>
        <li><a href="/apps/brain-arena/"><strong>Brain Arena</strong><span> · multiplayer trivia and geography party game</span></a></li>
      </ul>
    </nav>
    <p class="copyright">© Shevato LLC · <a href="/">shevato.com</a> · <a href="/about.html">About</a> · <a href="/contact.html">Contact</a></p>
  </footer>`;
}

module.exports = { renderMoreFooter };
