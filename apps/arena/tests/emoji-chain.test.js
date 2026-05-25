/*
 * Brain Arena — Emoji Chain helpers (Item #9).
 * Tests cover phrase picking determinism, normalize/match semantics,
 * and the per-round scoring tally (correct guess + funniest vote +
 * prompter bonus + tie handling).
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const EmojiChain = require('../js/emoji-chain.js');

test('PHRASES list is non-empty and unique', () => {
    assert.ok(Array.isArray(EmojiChain.PHRASES));
    assert.ok(EmojiChain.PHRASES.length >= 10);
    assert.equal(new Set(EmojiChain.PHRASES).size, EmojiChain.PHRASES.length,
        'no duplicate phrases');
});

test('normalizeGuess strips case + punctuation + whitespace', () => {
    assert.equal(EmojiChain.normalizeGuess('The Lion King'), 'thelionking');
    assert.equal(EmojiChain.normalizeGuess('  the LION-king!  '), 'thelionking');
    assert.equal(EmojiChain.normalizeGuess('Spider-Man 2'), 'spiderman2');
    assert.equal(EmojiChain.normalizeGuess(''), '');
    assert.equal(EmojiChain.normalizeGuess(null), '');
    assert.equal(EmojiChain.normalizeGuess(undefined), '');
});

test('guessMatches handles punctuation + case variants', () => {
    assert.equal(EmojiChain.guessMatches('The Lion King', 'thelionking'), true);
    assert.equal(EmojiChain.guessMatches('the-lion-king', 'The Lion King'), true);
    assert.equal(EmojiChain.guessMatches('Lion King', 'The Lion King'), false,
        'partial match should not count');
    assert.equal(EmojiChain.guessMatches('', 'truth'), false);
    assert.equal(EmojiChain.guessMatches('truth', ''), false);
});

test('pickPhrases returns N unique entries with stable ids', () => {
    const seq = [0.1, 0.5, 0.9, 0.2, 0.7];
    let i = 0;
    const rand = () => seq[i++ % seq.length];
    const out = EmojiChain.pickPhrases(3, rand);
    assert.equal(out.length, 3);
    const phrases = out.map((o) => o.phrase);
    assert.equal(new Set(phrases).size, 3, 'no duplicate phrases picked');
    for (const o of out) {
        assert.ok(EmojiChain.PHRASES.includes(o.phrase));
        assert.match(o.id, /^ec-\d+-[a-z0-9-]+$/);
    }
});

test('pickPhrases clamps count to pool size', () => {
    const huge = EmojiChain.pickPhrases(1000);
    assert.equal(huge.length, EmojiChain.PHRASES.length);
    // 0 / NaN / missing falls back to the default (3) because
    // `Number(0) || 3` is 3 in the helper.
    assert.equal(EmojiChain.pickPhrases(0).length, 3);
    assert.equal(EmojiChain.pickPhrases().length, 3);
    // -5 clamps up to the minimum of 1 via Math.max.
    assert.equal(EmojiChain.pickPhrases(-5).length, 1);
});

test('scoreRound awards correct-guess points only to matching uids', () => {
    const result = EmojiChain.scoreRound({
        truth: 'The Lion King',
        prompterUid: 'P',
        guesses: { A: 'the lion king', B: 'Hakuna Matata' },
        votes: {}
    });
    assert.equal(result.deltas.A, EmojiChain.POINTS_CORRECT_GUESS);
    assert.equal(result.deltas.B, undefined);
    // Prompter bonus fires because >=1 guesser got it right.
    assert.equal(result.deltas.P, EmojiChain.POINTS_PROMPTER_HIT);
    assert.deepEqual(result.correctGuessers, ['A']);
});

test('scoreRound no prompter bonus when nobody guesses right', () => {
    const result = EmojiChain.scoreRound({
        truth: 'Frozen',
        prompterUid: 'P',
        guesses: { A: 'Encanto', B: 'Moana' },
        votes: {}
    });
    assert.equal(result.deltas.P, undefined);
    assert.equal(result.deltas.A, undefined);
    assert.deepEqual(result.correctGuessers, []);
});

test('scoreRound funniest-vote winner gets the vote bonus', () => {
    const result = EmojiChain.scoreRound({
        truth: 'Frozen',
        prompterUid: 'P',
        guesses: { A: 'wrong-A', B: 'wrong-B' },
        votes: { C: 'A', D: 'A', E: 'B' }
    });
    assert.equal(result.deltas.A, EmojiChain.POINTS_FUNNIEST_VOTE);
    assert.equal(result.deltas.B, undefined);
    assert.equal(result.topUids[0], 'A');
    assert.equal(result.topVotes, 2);
});

test('scoreRound self-votes are ignored', () => {
    const result = EmojiChain.scoreRound({
        truth: 'Frozen',
        prompterUid: 'P',
        guesses: { A: 'wrong-A' },
        votes: { A: 'A', B: 'A' }
    });
    // B's vote for A counts; A's self-vote does not.
    assert.equal(result.voteTotals.A, 1);
});

test('scoreRound ties split the funniest-vote bonus to every top uid', () => {
    const result = EmojiChain.scoreRound({
        truth: 'Frozen',
        prompterUid: 'P',
        guesses: { A: 'x', B: 'y' },
        votes: { C: 'A', D: 'B' }
    });
    assert.equal(result.deltas.A, EmojiChain.POINTS_FUNNIEST_VOTE);
    assert.equal(result.deltas.B, EmojiChain.POINTS_FUNNIEST_VOTE);
    assert.equal(result.topVotes, 1);
    assert.equal(new Set(result.topUids).size, 2);
});

test('scoreRound deltas accumulate (correct + funniest)', () => {
    const result = EmojiChain.scoreRound({
        truth: 'Frozen',
        prompterUid: 'P',
        guesses: { A: 'frozen', B: 'wrong' },
        votes: { B: 'A' }  // B votes A funniest
    });
    // A got correct AND was voted funniest.
    assert.equal(result.deltas.A,
        EmojiChain.POINTS_CORRECT_GUESS + EmojiChain.POINTS_FUNNIEST_VOTE);
    assert.equal(result.deltas.P, EmojiChain.POINTS_PROMPTER_HIT);
});

test('scoreRound handles empty guesses + empty votes safely', () => {
    const result = EmojiChain.scoreRound({
        truth: 'Frozen', prompterUid: 'P', guesses: {}, votes: {}
    });
    assert.deepEqual(result.deltas, {});
    assert.deepEqual(result.voteTotals, {});
    assert.equal(result.topVotes, 0);
});
