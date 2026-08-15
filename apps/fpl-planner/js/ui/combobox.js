// A searchable combobox, built to the WAI-ARIA 1.2 combobox pattern.
//
// WHY IT EXISTS: the player picker was a native <select> holding every player in
// the game. At 577 options a native dropdown is a scrolling wall with no search,
// no club, no price and no projection, and on a phone it is an OS wheel. Picking
// "the third Rodrigo" out of it is not a task anyone completes.
//
// WHAT MAKES THIS ACCESSIBLE RATHER THAN LOOKING ACCESSIBLE:
//
//   - The input keeps focus at all times. Nothing steals it, so a screen reader
//     stays in the text field and reads the active option through
//     aria-activedescendant. This is the pattern's whole point: DOM focus never
//     moves into the list.
//   - aria-expanded tracks the real popup state, aria-controls names the
//     listbox, and every row is a role="option" with an id and aria-selected.
//   - The result count is announced through a polite live region, because a
//     filter that silently narrows from 577 rows to 2 is invisible to anyone not
//     looking at it.
//   - Escape has the two-stage behaviour the pattern specifies: close the list,
//     then clear the field.
//
// The keyboard model is the contract, so it is tested directly in
// tests/ui-combobox.test.mjs rather than inferred from the markup.

import { el } from './dom.js';

let sequence = 0;

export const COMBOBOX_PARAMS = Object.freeze({
  // Rows rendered at once. The filter runs over the whole list; only the
  // rendering is capped, and the live region always announces the true total.
  maxRendered: 50,
});

// `items` are `{ id, label, meta, trailing, search }`. `search` is the
// lower-cased haystack; when absent it is built from label and meta.
export function combobox({
  items,
  label,
  placeholder = 'Search',
  emptyText = 'No player matches that search.',
  onSelect = null,
  onInput = null,
} = {}) {
  const uid = `fpl-cb-${++sequence}`;
  const listId = `${uid}-listbox`;
  const rows = items.map(item => ({
    ...item,
    search: (item.search || `${item.label} ${item.meta || ''}`).toLowerCase(),
  }));

  let matches = rows.slice(0, COMBOBOX_PARAMS.maxRendered);
  let total = rows.length;
  let active = -1;
  let open = false;
  let selected = null;

  const input = el('input', {
    type: 'text',
    class: 'fpl-cb-input',
    id: `${uid}-input`,
    role: 'combobox',
    placeholder,
    autocomplete: 'off',
    spellcheck: 'false',
    'aria-label': label,
    'aria-expanded': 'false',
    'aria-controls': listId,
    'aria-autocomplete': 'list',
    'aria-haspopup': 'listbox',
  });

  const list = el('ul', { class: 'fpl-cb-list', id: listId, role: 'listbox', 'aria-label': label, hidden: true });
  const status = el('div', { class: 'fpl-cb-status', role: 'status', 'aria-live': 'polite' });
  const node = el('div', { class: 'fpl-cb' }, [input, list, status]);

  const optionId = (i) => `${uid}-opt-${i}`;

  function filter(query) {
    const q = query.trim().toLowerCase();
    if (!q) return { list: rows.slice(0, COMBOBOX_PARAMS.maxRendered), total: rows.length };
    const tokens = q.split(/\s+/);
    const hits = [];
    for (const item of rows) {
      let ok = true;
      for (const token of tokens) {
        if (!item.search.includes(token)) { ok = false; break; }
      }
      if (ok) hits.push(item);
    }
    return { list: hits.slice(0, COMBOBOX_PARAMS.maxRendered), total: hits.length };
  }

  function announce() {
    if (!open) {
      status.textContent = '';
      return;
    }
    if (total === 0) {
      status.textContent = emptyText;
      return;
    }
    const shown = matches.length;
    status.textContent = shown < total
      ? `${total} players match, showing the first ${shown}. Use the up and down arrow keys to review, Enter to choose.`
      : `${total} ${total === 1 ? 'player matches' : 'players match'}. Use the up and down arrow keys to review, Enter to choose.`;
  }

  function paint() {
    list.replaceChildren(...matches.map((item, i) => el('li', {
      class: `fpl-cb-opt ${i === active ? 'is-active' : ''}`.trim(),
      id: optionId(i),
      role: 'option',
      'aria-selected': i === active ? 'true' : 'false',
      dataset: { index: String(i) },
      onmousedown: (event) => {
        // Before blur, so the input never loses focus to the list.
        if (event && typeof event.preventDefault === 'function') event.preventDefault();
        choose(i);
      },
    }, [
      el('span', { class: 'fpl-cb-name', text: item.label }),
      item.meta ? el('span', { class: 'fpl-cb-meta', text: item.meta }) : null,
      item.trailing ? el('span', { class: 'fpl-cb-trail', text: item.trailing }) : null,
    ])));

    if (open && !matches.length) {
      list.replaceChildren(el('li', { class: 'fpl-cb-empty', role: 'presentation', text: emptyText }));
    }

    list.hidden = !open;
    input.setAttribute('aria-expanded', open ? 'true' : 'false');
    if (open && active >= 0 && active < matches.length) {
      input.setAttribute('aria-activedescendant', optionId(active));
      const el0 = list.childNodes[active];
      if (el0 && typeof el0.scrollIntoView === 'function') el0.scrollIntoView({ block: 'nearest' });
    } else {
      input.removeAttribute('aria-activedescendant');
    }
  }

  function openList(query) {
    const found = filter(query === undefined ? input.value : query);
    matches = found.list;
    total = found.total;
    open = true;
    if (active >= matches.length) active = matches.length - 1;
    paint();
    announce();
  }

  function closeList() {
    open = false;
    active = -1;
    paint();
    announce();
  }

  function move(delta) {
    if (!open) {
      openList();
      active = delta > 0 ? 0 : matches.length - 1;
      paint();
      return;
    }
    if (!matches.length) return;
    active = active === -1
      ? (delta > 0 ? 0 : matches.length - 1)
      : (active + delta + matches.length) % matches.length;
    paint();
  }

  function jump(index) {
    if (!open) openList();
    if (!matches.length) return;
    active = index < 0 ? matches.length - 1 : 0;
    paint();
  }

  function choose(index) {
    const item = matches[index];
    if (!item) return;
    selected = item;
    input.value = item.label;
    closeList();
    if (onSelect) onSelect(item);
  }

  input.addEventListener('input', () => {
    selected = null;
    active = -1;
    openList();
    // Pre-arming the first row is what makes "type three letters, press Enter"
    // work, which is how the control is actually used.
    if (matches.length) {
      active = 0;
      paint();
    }
    if (onInput) onInput(input.value);
  });

  input.addEventListener('keydown', (event) => {
    const stop = () => { if (typeof event.preventDefault === 'function') event.preventDefault(); };
    switch (event.key) {
      case 'ArrowDown': stop(); move(1); break;
      case 'ArrowUp': stop(); move(-1); break;
      case 'Home': if (open) { stop(); jump(0); } break;
      case 'End': if (open) { stop(); jump(-1); } break;
      case 'Enter':
        if (open && active >= 0) { stop(); choose(active); }
        break;
      case 'Escape':
        stop();
        if (open) closeList();
        else { input.value = ''; selected = null; if (onInput) onInput(''); }
        break;
      case 'Tab':
        if (open) closeList();
        break;
      default:
        break;
    }
  });

  input.addEventListener('focus', () => { if (input.value.trim()) openList(); });
  input.addEventListener('blur', () => closeList());

  return {
    node,
    input,
    list,
    // Show the list without waiting for a keystroke. The picker that replaces a
    // player opens straight onto the ranked options, because the question there
    // is "who is available" rather than "find the one I already have in mind".
    // Existing callers keep the type-to-open behaviour by simply not calling it.
    open(query) { openList(query); },
    get value() { return selected; },
    get isOpen() { return open; },
    get activeIndex() { return active; },
    get matches() { return matches; },
    clear() {
      input.value = '';
      selected = null;
      closeList();
    },
  };
}
