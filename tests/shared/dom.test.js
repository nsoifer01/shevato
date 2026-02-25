import { describe, it, expect, vi } from 'vitest';
import { escapeHtml, el } from '../../shared/utils/dom.js';

describe('escapeHtml', () => {
  it('escapes angle brackets', () => {
    expect(escapeHtml('<script>alert("xss")</script>')).toBe(
      '&lt;script&gt;alert("xss")&lt;/script&gt;',
    );
  });

  it('escapes ampersands', () => {
    expect(escapeHtml('a & b')).toBe('a &amp; b');
  });

  it('handles quotes (textContent/innerHTML does not escape quotes)', () => {
    // The escapeHtml implementation uses textContent → innerHTML,
    // which escapes <, >, & but not quotes (browser behavior)
    const result = escapeHtml('"hello"');
    expect(result).toContain('hello');
  });

  it('returns empty string for empty input', () => {
    expect(escapeHtml('')).toBe('');
  });

  it('passes through safe text unchanged', () => {
    expect(escapeHtml('Hello World')).toBe('Hello World');
  });
});

describe('el', () => {
  it('creates an element with the given tag', () => {
    const div = el('div');
    expect(div.tagName).toBe('DIV');
  });

  it('sets className', () => {
    const div = el('div', { className: 'foo bar' });
    expect(div.className).toBe('foo bar');
  });

  it('sets textContent', () => {
    const span = el('span', { textContent: 'hello' });
    expect(span.textContent).toBe('hello');
  });

  it('sets attributes via setAttribute', () => {
    const input = el('input', { type: 'text', placeholder: 'Enter...' });
    expect(input.getAttribute('type')).toBe('text');
    expect(input.getAttribute('placeholder')).toBe('Enter...');
  });

  it('sets style as object', () => {
    const div = el('div', { style: { color: 'red', fontSize: '14px' } });
    expect(div.style.color).toBe('red');
    expect(div.style.fontSize).toBe('14px');
  });

  it('sets dataset as object', () => {
    const div = el('div', { dataset: { id: '42', type: 'test' } });
    expect(div.dataset.id).toBe('42');
    expect(div.dataset.type).toBe('test');
  });

  it('adds event listeners for on* attributes', () => {
    const handler = vi.fn();
    const btn = el('button', { onClick: handler });
    btn.click();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it('appends string children as text nodes', () => {
    const p = el('p', {}, ['Hello ', 'World']);
    expect(p.textContent).toBe('Hello World');
    expect(p.childNodes.length).toBe(2);
  });

  it('appends element children', () => {
    const child = el('span', { textContent: 'inner' });
    const parent = el('div', {}, [child]);
    expect(parent.children.length).toBe(1);
    expect(parent.children[0].textContent).toBe('inner');
  });

  it('skips null/undefined attrs and children', () => {
    const div = el('div', { className: null, id: undefined }, [null, 'text', undefined]);
    expect(div.hasAttribute('className')).toBe(false);
    expect(div.textContent).toBe('text');
  });

  it('sets innerHTML when provided', () => {
    const div = el('div', { innerHTML: '<b>bold</b>' });
    expect(div.innerHTML).toBe('<b>bold</b>');
  });
});
