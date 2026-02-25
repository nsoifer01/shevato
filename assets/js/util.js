/**
 * Panel — vanilla-JS replacement for the former jQuery $.fn.panel plugin.
 * Handles toggle-visible class on body, click-outside-to-close, swipe-to-close,
 * escape-to-close, link-click interception, and scroll/form reset.
 *
 * @module util
 */

export class Panel {
  /**
   * @param {HTMLElement} element - The panel element (e.g. #menu).
   * @param {object}      opts
   * @param {HTMLElement}  [opts.target=document.body] - Element to toggle visibleClass on.
   * @param {string}       [opts.visibleClass='visible']
   * @param {number}       [opts.delay=0]
   * @param {boolean}      [opts.hideOnClick=false]  - Hide when a link inside is clicked.
   * @param {boolean}      [opts.hideOnSwipe=false]
   * @param {boolean}      [opts.hideOnEscape=false]
   * @param {boolean}      [opts.resetScroll=false]
   * @param {boolean}      [opts.resetForms=false]
   * @param {string|null}  [opts.side=null]  - 'left'|'right'|'top'|'bottom'
   */
  constructor(element, opts = {}) {
    this.el = element;
    this.id = element.id;
    this.cfg = {
      target: document.body,
      visibleClass: 'visible',
      delay: 0,
      hideOnClick: false,
      hideOnSwipe: false,
      hideOnEscape: false,
      resetScroll: false,
      resetForms: false,
      side: null,
      ...opts,
    };

    this._touchStartX = null;
    this._touchStartY = null;

    this._bind();
  }

  /* ---- public ---------------------------------------------------------- */

  hide(event) {
    if (!this.cfg.target.classList.contains(this.cfg.visibleClass)) return;

    if (event) {
      event.preventDefault();
      event.stopPropagation();
    }

    this.cfg.target.classList.remove(this.cfg.visibleClass);

    setTimeout(() => {
      if (this.cfg.resetScroll) this.el.scrollTop = 0;
      if (this.cfg.resetForms) {
        this.el.querySelectorAll('form').forEach((f) => f.reset());
      }
    }, this.cfg.delay);
  }

  /* ---- private --------------------------------------------------------- */

  _bind() {
    // --- Panel-level listeners -------------------------------------------

    // Hide on link click (intercept & redirect after delay)
    if (this.cfg.hideOnClick) {
      this.el.addEventListener('click', (e) => {
        const a = e.target.closest('a');
        if (!a) return;

        const href = a.getAttribute('href');
        const target = a.getAttribute('target');
        if (!href || href === '#' || href === '' || href === '#' + this.id) return;

        e.preventDefault();
        e.stopPropagation();
        this.hide();

        setTimeout(() => {
          if (target === '_blank') window.open(href);
          else window.location.href = href;
        }, this.cfg.delay + 10);
      });
    }

    // Touch: swipe-to-close + prevent overscroll
    this.el.addEventListener(
      'touchstart',
      (e) => {
        this._touchStartX = e.touches[0].pageX;
        this._touchStartY = e.touches[0].pageY;
      },
      { passive: true },
    );

    this.el.addEventListener(
      'touchmove',
      (e) => {
        if (this._touchStartX === null || this._touchStartY === null) return;

        const diffX = this._touchStartX - e.touches[0].pageX;
        const diffY = this._touchStartY - e.touches[0].pageY;

        // Swipe detection
        if (this.cfg.hideOnSwipe) {
          const boundary = 20;
          const delta = 50;
          let shouldHide = false;

          switch (this.cfg.side) {
            case 'left':
              shouldHide = Math.abs(diffY) < boundary && diffX > delta;
              break;
            case 'right':
              shouldHide = Math.abs(diffY) < boundary && diffX < -delta;
              break;
            case 'top':
              shouldHide = Math.abs(diffX) < boundary && diffY > delta;
              break;
            case 'bottom':
              shouldHide = Math.abs(diffX) < boundary && diffY < -delta;
              break;
          }

          if (shouldHide) {
            this._touchStartX = null;
            this._touchStartY = null;
            this.hide();
            return;
          }
        }

        // Prevent vertical overscroll
        const th = this.el.offsetHeight;
        const ts = this.el.scrollHeight - this.el.scrollTop;
        if ((this.el.scrollTop < 0 && diffY < 0) || (ts > th - 2 && ts < th + 2 && diffY > 0)) {
          e.preventDefault();
        }
      },
      { passive: false },
    );

    // Stop events from bubbling out of the panel
    this.el.addEventListener('click', (e) => e.stopPropagation());

    // Close-link inside panel (a[href="#<id>"])
    if (this.id) {
      this.el.addEventListener('click', (e) => {
        const a = e.target.closest('a[href="#' + this.id + '"]');
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        this.cfg.target.classList.remove(this.cfg.visibleClass);
      });
    }

    // --- Body-level listeners --------------------------------------------

    // Click / tap outside panel → hide
    document.body.addEventListener('click', (e) => this.hide(e));

    // Toggle link on body (a[href="#<id>"])
    if (this.id) {
      document.body.addEventListener('click', (e) => {
        const a = e.target.closest('a[href="#' + this.id + '"]');
        if (!a) return;
        e.preventDefault();
        e.stopPropagation();
        this.cfg.target.classList.toggle(this.cfg.visibleClass);
      });
    }

    // --- Window-level listeners ------------------------------------------

    if (this.cfg.hideOnEscape) {
      window.addEventListener('keydown', (e) => {
        if (e.key === 'Escape') this.hide(e);
      });
    }
  }
}
