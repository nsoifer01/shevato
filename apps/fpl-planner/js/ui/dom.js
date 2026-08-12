// Tiny DOM helpers. No framework, no templating library: the whole app is a
// few hundred nodes and building them by hand keeps the data flow visible.
//
// Nothing here touches `document` at module scope, so this file imports cleanly
// under `node --test`.

export function el(tag, attrs, children) {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else if (k === 'html') node.innerHTML = v;
      else if (k === 'dataset') Object.assign(node.dataset, v);
      else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
      else if (v === true) node.setAttribute(k, '');
      else node.setAttribute(k, String(v));
    }
  }
  append(node, children);
  return node;
}

export function append(node, children) {
  if (children === null || children === undefined || children === false) return node;
  if (Array.isArray(children)) {
    for (const c of children) append(node, c);
    return node;
  }
  node.appendChild(typeof children === 'object' ? children : document.createTextNode(String(children)));
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
  return node;
}

export function mount(node, children) {
  clear(node);
  append(node, children);
  return node;
}

// The standard section shell: an uppercase title row with an optional aside,
// and a padded body.
export function card(title, body, { aside = null, className = '' } = {}) {
  return el('section', { class: `fpl-card ${className}`.trim() }, [
    el('div', { class: 'fpl-card-head' }, [el('h3', { text: title }), aside]),
    el('div', { class: 'fpl-card-body' }, body),
  ]);
}

// A collapsible section. `open` is the initial state only; the browser owns it
// afterwards, so a user who expands the model status keeps it expanded through
// a re-render only if the caller passes the remembered value back in.
export function disclosure(title, body, { open = false, className = '' } = {}) {
  return el('details', { class: `fpl-disclosure ${className}`.trim(), open }, [
    el('summary', {}, title),
    el('div', { class: 'fpl-disclosure-body' }, body),
  ]);
}

export function stat(label, value, { kClass = 'fpl-stat-k', vClass = 'fpl-stat-v', note = null, className = '' } = {}) {
  return el('div', { class: className }, [
    el('div', { class: kClass, text: label }),
    el('div', { class: vClass, text: value }),
    note ? el('div', { class: 'fpl-fact-note', text: note }) : null,
  ]);
}
