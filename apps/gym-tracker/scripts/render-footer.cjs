'use strict';

// Shared footer used by every static page in this app. Inlined into the
// HTML at build time — no JS partial-include — so the cross-app links
// are visible to Googlebot and to JS-disabled visitors. Keep this in
// sync with apps/rising-seasons/scripts/render-footer.js.
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

// Floating "back to top" button for static exercise pages. Scrolls
// the window (not an inner panel). The inline script is intentionally
// tiny to avoid a new network request.
function renderScrollTopButton() {
  return `<button type="button" class="ex-scroll-top" aria-label="Scroll back to top" title="Back to top">
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 12V2M2 7l5-5 5 5"/></svg>
    <span>Top</span>
  </button>
  <script>(function(){var btn=document.querySelector('.ex-scroll-top');if(!btn)return;window.addEventListener('scroll',function(){btn.classList.toggle('ex-scroll-top--visible',window.scrollY>=400);},{passive:true});btn.addEventListener('click',function(){window.scrollTo({top:0,behavior:'smooth'});});}());</script>`;
}

module.exports = { renderMoreFooter, renderScrollTopButton };
