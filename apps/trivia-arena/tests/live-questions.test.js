'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');

const { normalizeLiveQuestion, normalizeCategory } = require('../js/live-questions.js');

// --- normalizeCategory -------------------------------------------------

test('normalizeCategory: titlecase -> lowercase kebab', () => {
    assert.equal(normalizeCategory('Geography'), 'geography');
});

test('normalizeCategory: & becomes "and"', () => {
    assert.equal(normalizeCategory('Sport & Leisure'), 'sport-and-leisure');
});

test('normalizeCategory: punctuation collapses to single dash', () => {
    assert.equal(normalizeCategory('Film,  TV    and Music'), 'film-tv-and-music');
});

test('normalizeCategory: empty / missing -> "general"', () => {
    assert.equal(normalizeCategory(''), 'general');
    assert.equal(normalizeCategory(null), 'general');
    assert.equal(normalizeCategory(undefined), 'general');
});

test('normalizeCategory: capped at 32 chars', () => {
    const long = 'A'.repeat(80);
    assert.ok(normalizeCategory(long).length <= 32);
});

test('normalizeCategory: leading/trailing dashes stripped', () => {
    assert.equal(normalizeCategory('!!! Music !!!'), 'music');
});

// --- normalizeLiveQuestion ---------------------------------------------

function rawQ(over = {}) {
    return Object.assign({
        id: 'qid-1',
        category: 'Geography',
        question: { text: 'What is the capital of France?' },
        correctAnswer: 'Paris',
        incorrectAnswers: ['London', 'Berlin', 'Madrid'],
        difficulty: 'easy',
        type: 'text_choice'
    }, over);
}

// Pin shuffleFn to identity so correctIndex is deterministic in tests.
const identity = (arr) => arr.slice();

test('normalizeLiveQuestion: happy path -> internal shape', () => {
    const out = normalizeLiveQuestion(rawQ(), identity);
    assert.equal(out.id, 'qid-1');
    assert.equal(out.category, 'geography');
    assert.equal(out.question, 'What is the capital of France?');
    assert.deepEqual(out.choices, ['Paris', 'London', 'Berlin', 'Madrid']);
    assert.equal(out.correctIndex, 0);
});

test('normalizeLiveQuestion: accepts question as a plain string too', () => {
    const out = normalizeLiveQuestion(rawQ({ question: 'Direct string?' }), identity);
    assert.equal(out.question, 'Direct string?');
});

test('normalizeLiveQuestion: shuffle is honored and correctIndex tracks it', () => {
    // Reverse shuffle for a clearly different ordering.
    const reverse = (arr) => arr.slice().reverse();
    const out = normalizeLiveQuestion(rawQ(), reverse);
    assert.deepEqual(out.choices, ['Madrid', 'Berlin', 'London', 'Paris']);
    assert.equal(out.correctIndex, 3);
    assert.equal(out.choices[out.correctIndex], 'Paris');
});

test('normalizeLiveQuestion: missing question text -> null', () => {
    assert.equal(normalizeLiveQuestion(rawQ({ question: { text: '' } }), identity), null);
    assert.equal(normalizeLiveQuestion(rawQ({ question: null }), identity), null);
});

test('normalizeLiveQuestion: missing correctAnswer -> null', () => {
    assert.equal(normalizeLiveQuestion(rawQ({ correctAnswer: '' }), identity), null);
    assert.equal(normalizeLiveQuestion(rawQ({ correctAnswer: undefined }), identity), null);
});

test('normalizeLiveQuestion: empty incorrectAnswers -> null', () => {
    assert.equal(normalizeLiveQuestion(rawQ({ incorrectAnswers: [] }), identity), null);
    assert.equal(normalizeLiveQuestion(rawQ({ incorrectAnswers: undefined }), identity), null);
});

test('normalizeLiveQuestion: filters out non-string incorrect answers', () => {
    const out = normalizeLiveQuestion(rawQ({
        incorrectAnswers: ['London', null, 'Berlin', '', undefined, 'Madrid']
    }), identity);
    assert.deepEqual(out.choices, ['Paris', 'London', 'Berlin', 'Madrid']);
});

test('normalizeLiveQuestion: very long question text capped at 280 chars', () => {
    const long = 'Q'.repeat(500);
    const out = normalizeLiveQuestion(rawQ({ question: { text: long } }), identity);
    assert.equal(out.question.length, 280);
});

test('normalizeLiveQuestion: very long choice strings capped at 120 chars', () => {
    const longChoice = 'C'.repeat(500);
    const out = normalizeLiveQuestion(rawQ({
        correctAnswer: longChoice,
        incorrectAnswers: [longChoice, longChoice, longChoice]
    }), identity);
    out.choices.forEach((c) => assert.equal(c.length, 120));
});

test('normalizeLiveQuestion: malformed root -> null', () => {
    assert.equal(normalizeLiveQuestion(null, identity), null);
    assert.equal(normalizeLiveQuestion('string', identity), null);
    assert.equal(normalizeLiveQuestion(42, identity), null);
});
