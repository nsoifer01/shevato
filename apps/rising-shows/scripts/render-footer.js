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
        <li><a href="/apps/arena/"><strong>Arena</strong><span> · multiplayer party games with friends in private rooms</span></a></li>
        <li><a href="/apps/football-h2h/"><strong>Football H2H</strong><span> · head-to-head match tracker</span></a></li>
        <li><a href="/apps/gym-tracker/"><strong>Gym Tracker</strong><span> · workouts and strength progress</span></a></li>
        <li><a href="/apps/maptap-rivals/"><strong>MapTap Rivals</strong><span> · daily MapTap.gg tracker</span></a></li>
        <li><a href="/apps/mario-kart/"><strong>Mario Kart Tracker</strong><span> · race tracker and stats</span></a></li>
        <li><a href="/apps/rising-shows/"><strong>Rising Shows</strong><span> · TV shows by the shape of their rating trend</span></a></li>
        <li><a href="/apps/trip-planner/"><strong>Trip Planner</strong><span> · itineraries with maps, costs and warnings</span></a></li>
      </ul>
    </nav>
    <div class="data-attribution">
      <a class="tmdb-logo-link" href="https://www.themoviedb.org/" target="_blank" rel="noopener noreferrer" aria-label="The Movie Database (TMDB)"><img class="tmdb-logo" src="/apps/rising-shows/images/tmdb-logo.svg" alt="TMDB" width="108" height="14" loading="lazy"></a>
      <p>This product uses the TMDB API but is not endorsed or certified by TMDB. Streaming data powered by <a href="https://www.justwatch.com/" target="_blank" rel="noopener noreferrer">JustWatch</a>. Information courtesy of IMDb (<a href="https://www.imdb.com/" target="_blank" rel="noopener noreferrer">https://www.imdb.com</a>). Used with permission.</p>
    </div>
    <p class="copyright">© Shevato LLC · <a href="/">shevato.com</a> · <a href="/about.html">About</a> · <a href="/contact.html">Contact</a></p>
  </footer>`;
}

module.exports = { renderMoreFooter };
