/**
 * Escape HTML to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped HTML string
 */
export function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Create a DOM element with attributes and children.
 * @param {string} tag - HTML tag name
 * @param {Object} [attrs={}] - Attributes and properties
 * @param {Array} [children=[]] - Child elements or strings (text nodes)
 * @returns {HTMLElement}
 *
 * Special attribute keys:
 *   className  → element.className
 *   textContent → element.textContent
 *   on<Event>  → element.addEventListener(<event>, handler)
 *   style (object) → Object.assign(element.style, value)
 *   dataset (object) → Object.assign(element.dataset, value)
 *   innerHTML → element.innerHTML (use only for trusted static content)
 *
 * Everything else is set via setAttribute().
 */
export function el(tag, attrs = {}, children = []) {
  const element = document.createElement(tag);

  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null) continue;

    if (key === 'className') {
      element.className = value;
    } else if (key === 'textContent') {
      element.textContent = value;
    } else if (key === 'innerHTML') {
      element.innerHTML = value;
    } else if (key === 'style' && typeof value === 'object') {
      Object.assign(element.style, value);
    } else if (key === 'dataset' && typeof value === 'object') {
      Object.assign(element.dataset, value);
    } else if (key.startsWith('on') && typeof value === 'function') {
      element.addEventListener(key.slice(2).toLowerCase(), value);
    } else {
      element.setAttribute(key, value);
    }
  }

  for (const child of children) {
    if (typeof child === 'string') {
      element.appendChild(document.createTextNode(child));
    } else if (child) {
      element.appendChild(child);
    }
  }

  return element;
}
