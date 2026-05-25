/*
 * Brain Arena — Word Blitz unit tests.
 * Pure-helper coverage for the typing-race game (Item #6).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const WordBlitz = require('../js/word-blitz.js');

test('normalizeWord lowercases and strips non-letters', () => {
    assert.equal(WordBlitz.normalizeWord('Lighthouse'), 'lighthouse');
    assert.equal(WordBlitz.normalizeWord(' lighthouse '), 'lighthouse');
    assert.equal(WordBlitz.normalizeWord('Light-house'), 'lighthouse');
    assert.equal(WordBlitz.normalizeWord("LIGHTHOUSE!"), 'lighthouse');
    assert.equal(WordBlitz.normalizeWord(''), '');
    assert.equal(WordBlitz.normalizeWord(null), '');
});

test('wordsMatch is case- and punctuation-insensitive', () => {
    assert.equal(WordBlitz.wordsMatch('Lighthouse', 'lighthouse'), true);
    assert.equal(WordBlitz.wordsMatch('LIGHT-HOUSE', 'lighthouse'), true);
    assert.equal(WordBlitz.wordsMatch(' light house ', 'lighthouse'), true);
    assert.equal(WordBlitz.wordsMatch('lightHouse', 'lighthouses'), false);
    assert.equal(WordBlitz.wordsMatch('', 'lighthouse'), false);
    assert.equal(WordBlitz.wordsMatch('lighthouse', ''), false);
});

test('buildWordList picks N words without replacement', () => {
    const pool = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'];
    // Pin RNG so the test is deterministic.
    let i = 0;
    const seq = [0.1, 0.5, 0.9, 0.2, 0.7];
    const rand = () => seq[i++ % seq.length];
    const out = WordBlitz.buildWordList(pool, 3, rand);
    assert.equal(out.length, 3);
    const words = out.map((o) => o.word);
    assert.equal(new Set(words).size, 3, 'no duplicates');
    for (const o of out) {
        assert.ok(pool.includes(o.word));
        assert.match(o.id, /^wb-\d+-/);
    }
});

test('buildWordList clamps count to pool size', () => {
    const pool = ['alpha', 'beta'];
    const out = WordBlitz.buildWordList(pool, 10);
    assert.equal(out.length, 2);
});

test('buildWordList accepts {word} objects', () => {
    const pool = [{ word: 'alpha' }, { word: 'beta' }, { word: 'gamma' }];
    const out = WordBlitz.buildWordList(pool, 2);
    assert.equal(out.length, 2);
    for (const o of out) {
        assert.ok(['alpha', 'beta', 'gamma'].includes(o.word));
    }
});

test('buildWordList returns [] on empty / invalid pool', () => {
    assert.deepEqual(WordBlitz.buildWordList([], 5), []);
    assert.deepEqual(WordBlitz.buildWordList(null, 5), []);
    assert.deepEqual(WordBlitz.buildWordList([''], 5), []);
});
