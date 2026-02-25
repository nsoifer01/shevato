import { describe, it, expect } from 'vitest';
import { storageGet, storageSet, storageRemove } from '../../shared/utils/storage.js';

describe('storageGet', () => {
  it('returns parsed JSON value', () => {
    localStorage.setItem('test', JSON.stringify({ a: 1 }));
    expect(storageGet('test')).toEqual({ a: 1 });
  });

  it('returns default value for missing key', () => {
    expect(storageGet('missing')).toBeNull();
    expect(storageGet('missing', 'fallback')).toBe('fallback');
  });

  it('returns default value for invalid JSON', () => {
    localStorage.setItem('bad', '{invalid');
    expect(storageGet('bad', 'default')).toBe('default');
  });

  it('handles arrays', () => {
    localStorage.setItem('arr', JSON.stringify([1, 2, 3]));
    expect(storageGet('arr')).toEqual([1, 2, 3]);
  });

  it('handles primitives', () => {
    localStorage.setItem('num', '42');
    expect(storageGet('num')).toBe(42);

    localStorage.setItem('str', '"hello"');
    expect(storageGet('str')).toBe('hello');

    localStorage.setItem('bool', 'true');
    expect(storageGet('bool')).toBe(true);
  });
});

describe('storageSet', () => {
  it('stores JSON value', () => {
    storageSet('key', { name: 'test' });
    expect(JSON.parse(localStorage.getItem('key'))).toEqual({ name: 'test' });
  });

  it('returns true on success', () => {
    expect(storageSet('key', 'value')).toBe(true);
  });

  it('stores arrays', () => {
    storageSet('arr', [1, 2, 3]);
    expect(JSON.parse(localStorage.getItem('arr'))).toEqual([1, 2, 3]);
  });
});

describe('storageRemove', () => {
  it('removes the key', () => {
    localStorage.setItem('key', 'value');
    storageRemove('key');
    expect(localStorage.getItem('key')).toBeNull();
  });

  it('returns true on success', () => {
    expect(storageRemove('key')).toBe(true);
  });

  it('returns true even if key does not exist', () => {
    expect(storageRemove('nonexistent')).toBe(true);
  });
});
