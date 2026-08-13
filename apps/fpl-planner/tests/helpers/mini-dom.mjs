// A DOM small enough to render this app's real view modules under `node --test`.
//
// It exists so that the deletion flow and the pitch's blank/double-gameweek
// markers are verified by running the code that ships, rather than by
// re-describing it inside a test. Only what js/ui/dom.js and the views built on
// it actually touch is implemented; a missing piece shows up as a TypeError on
// the spot instead of a quietly wrong assertion.
//
// Not a browser: no layout, no CSS, no bubbling. Anything that depends on those
// (hover, focus, real typing) belongs in .features/fpl-planner-human.md.

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this.data = String(text);
    this.parentNode = null;
  }

  get textContent() { return this.data; }

  set textContent(value) { this.data = String(value); }
}

// Boolean attributes the views flip as properties after render (`confirmBox.hidden
// = false`, `button.disabled = true`), which in a real DOM reflect to the
// attribute and back.
const REFLECTED_BOOLEANS = ['hidden', 'disabled', 'selected', 'open', 'checked'];

class ElementNode {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.childNodes = [];
    this.parentNode = null;
    this.className = '';
    this.dataset = {};
    this.attributes = new Map();
    this.listeners = new Map();
    this._value = undefined;
  }

  // A <select> with nothing chosen reads as its selected option, or its first
  // one, exactly as a browser does: the views read `select.value` directly.
  get value() {
    if (this._value !== undefined) return this._value;
    if (this.tagName === 'SELECT') {
      const options = [...walk(this)].filter(n => n.tagName === 'OPTION');
      const chosen = options.find(o => o.selected) || options[0];
      return chosen ? chosen.value : '';
    }
    return '';
  }

  set value(v) { this._value = String(v); }

  get firstChild() { return this.childNodes[0] || null; }

  get children() { return this.childNodes.filter(n => n.nodeType === 1); }

  get textContent() {
    return this.childNodes.map(n => n.textContent).join('');
  }

  set textContent(value) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.appendChild(new TextNode(value));
  }

  get innerHTML() { return this.textContent; }

  set innerHTML(value) {
    this.textContent = value;
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
    if (name === 'value') this.value = String(value);
    if (name === 'class') this.className = String(value);
  }

  getAttribute(name) {
    return this.attributes.has(name) ? this.attributes.get(name) : null;
  }

  hasAttribute(name) { return this.attributes.has(name); }

  removeAttribute(name) { this.attributes.delete(name); }

  appendChild(child) {
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  append(...nodes) {
    for (const node of nodes) {
      if (node === null || node === undefined) continue;
      this.appendChild(typeof node === 'object' ? node : new TextNode(node));
    }
  }

  removeChild(child) {
    const i = this.childNodes.indexOf(child);
    if (i >= 0) this.childNodes.splice(i, 1);
    child.parentNode = null;
    return child;
  }

  replaceChildren(...nodes) {
    for (const child of this.childNodes) child.parentNode = null;
    this.childNodes = [];
    this.append(...nodes);
  }

  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
}

for (const name of REFLECTED_BOOLEANS) {
  Object.defineProperty(ElementNode.prototype, name, {
    get() { return this.attributes.has(name); },
    set(value) {
      if (value) this.attributes.set(name, '');
      else this.attributes.delete(name);
    },
  });
}

export function createDocument() {
  return {
    createElement: (tag) => new ElementNode(tag),
    createTextNode: (text) => new TextNode(text),
  };
}

// Installs `document` (and `window`, which js/ui/settings.js reads for the
// signed-in session) for the duration of a test file. Returns the teardown.
export function installDom({ window: win = {} } = {}) {
  const previousDocument = globalThis.document;
  const previousWindow = globalThis.window;
  globalThis.document = createDocument();
  globalThis.window = win;
  return () => {
    globalThis.document = previousDocument;
    globalThis.window = previousWindow;
  };
}

export function* walk(node) {
  if (!node || node.nodeType !== 1) return;
  yield node;
  for (const child of node.childNodes) yield* walk(child);
}

export function classesOf(node) {
  return new Set(String(node.className || '').split(/\s+/).filter(Boolean));
}

export function queryAll(root, className) {
  return [...walk(root)].filter(n => classesOf(n).has(className));
}

export function query(root, className) {
  return queryAll(root, className)[0] || null;
}

export function textOf(node) {
  return node ? node.textContent.trim() : '';
}

// Finds a control by the label a user actually reads. Throws when the label
// drifts, which is the point: these strings are the promise the UI makes.
export function buttonWith(root, label) {
  const match = [...walk(root)].filter(n => n.tagName === 'BUTTON' && textOf(n) === label);
  if (!match.length) {
    const seen = [...walk(root)].filter(n => n.tagName === 'BUTTON').map(n => textOf(n));
    throw new Error(`no button labelled "${label}". Buttons present: ${JSON.stringify(seen)}`);
  }
  return match[0];
}

export async function fire(node, type, init = {}) {
  const handlers = node.listeners.get(type);
  if (!handlers || !handlers.length) {
    throw new Error(`fired "${type}" on <${node.tagName.toLowerCase()}> "${textOf(node)}" but it has no ${type} handler`);
  }
  const event = {
    type,
    target: node,
    defaultPrevented: false,
    preventDefault() { event.defaultPrevented = true; },
    stopPropagation() {},
    ...init,
  };
  for (const handler of handlers) await handler(event);
  return event;
}

// A key press on a control that has a keydown handler. Not a real keystroke:
// it does not move focus, type a character or open a mobile keyboard, and the
// combobox is written so that none of its keyboard behaviour depends on those.
export function pressKey(node, key) {
  return fire(node, 'keydown', { key });
}

export function click(node) {
  return fire(node, 'click');
}

// What a user typing into a search box produces: the field's value changes and
// an `input` event fires. Not a keystroke, and deliberately not claimed to be
// one; real typing, focus and mobile keyboards stay in the human test plan.
export function typeInto(node, text) {
  node.value = text;
  return fire(node, 'input');
}

// A localStorage stand-in that records how a key left, because the difference
// matters: sync-system only writes a cloud tombstone for removeItem(), so a
// deletion that used clear() would silently resurrect on the next device.
export function fakeStorage(seed = {}) {
  const map = new Map(Object.entries(seed));
  const removed = [];
  return {
    removed,
    get length() { return map.size; },
    key(i) { return [...map.keys()][i] ?? null; },
    getItem(key) { return map.has(key) ? map.get(key) : null; },
    setItem(key, value) { map.set(key, String(value)); },
    removeItem(key) { removed.push(key); map.delete(key); },
    clear() { throw new Error('clear() would skip the sync tombstone; the app must remove keys one by one'); },
    snapshot() { return Object.fromEntries(map); },
  };
}
