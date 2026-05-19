/*
 * Brain Arena — live-question source (The Trivia API).
 *
 * The Trivia API (the-trivia-api.com) is a free, no-key, CC-BY-licensed
 * question bank with ~30K questions. We hit /v2/questions which returns
 * an array of objects like:
 *   {
 *     id, category: "Geography",
 *     question: { text: "..." },
 *     correctAnswer: "Paris",
 *     incorrectAnswers: ["London","Berlin","Madrid"],
 *     tags: [...], type: "text_choice", difficulty: "medium"
 *   }
 *
 * normalizeLiveQuestion converts one of those into the same shape the
 * rest of the app uses (id/category/question/choices/correctIndex) and
 * is pure (takes an injectable shuffle), so it's testable in node.
 *
 * fetchLiveQuestions does the network call + normalization in one shot;
 * it's browser-only.
 */
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        const ns = root.BrainArena = root.BrainArena || {};
        ns.LiveQuestions = factory();
    }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    const API_URL = 'https://the-trivia-api.com/v2/questions';

    /**
     * Normalize a single raw API question into the app's internal shape.
     * Returns null when the raw record is malformed (caller should skip).
     * @param {object} raw — one element of the API's array response
     * @param {(arr:Array)=>Array} shuffleFn — injectable shuffle (pure)
     * @returns {object|null}
     */
    function normalizeLiveQuestion(raw, shuffleFn) {
        if (!raw || typeof raw !== 'object') return null;
        const text = raw.question && typeof raw.question === 'object'
            ? raw.question.text
            : raw.question;
        const correct = raw.correctAnswer;
        const incorrect = Array.isArray(raw.incorrectAnswers) ? raw.incorrectAnswers : [];
        if (!text || typeof text !== 'string') return null;
        if (typeof correct !== 'string' || !correct.trim()) return null;
        if (!incorrect.length) return null;

        const choices = [correct, ...incorrect.filter((s) => typeof s === 'string' && s.trim())];
        if (choices.length < 2) return null;
        const shuffled = (typeof shuffleFn === 'function' ? shuffleFn(choices) : choices.slice());
        const correctIndex = shuffled.indexOf(correct);
        if (correctIndex < 0) return null;

        return {
            id: String(raw.id || `live-${Math.random().toString(36).slice(2, 10)}`),
            category: normalizeCategory(raw.category),
            question: String(text).slice(0, 280),
            choices: shuffled.map((c) => String(c).slice(0, 120)),
            correctIndex
        };
    }

    /**
     * Normalize the API's titlecased / punctuated category names into our
     * lowercase-kebab convention ("Sport & Leisure" -> "sport-and-leisure").
     * Capped at 32 chars so the UI doesn't overflow.
     * @param {string} cat
     * @returns {string}
     */
    function normalizeCategory(cat) {
        return String(cat || 'general')
            .toLowerCase()
            .replace(/&/g, 'and')
            .replace(/[^a-z0-9]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .slice(0, 32) || 'general';
    }

    /**
     * Fetch `count` questions from The Trivia API and normalize them.
     * Throws on network failure, non-2xx status, or empty/invalid response —
     * caller should catch and fall back to the local pack.
     * @param {number} count
     * @param {(arr:Array)=>Array} shuffleFn
     * @returns {Promise<Array>}
     */
    async function fetchLiveQuestions(count, shuffleFn) {
        // API caps at 50/request; we ask for what we need.
        const n = Math.max(1, Math.min(50, Number(count) || 10));
        const url = `${API_URL}?limit=${n}&difficulties=easy,medium`;
        const res = await fetch(url, { cache: 'no-cache' });
        if (!res.ok) throw new Error(`Trivia API HTTP ${res.status}`);
        const raw = await res.json();
        if (!Array.isArray(raw) || !raw.length) throw new Error('Trivia API empty response');
        const normalized = raw
            .map((q) => normalizeLiveQuestion(q, shuffleFn))
            .filter((q) => q !== null);
        if (!normalized.length) throw new Error('Trivia API returned no usable questions');
        return normalized;
    }

    return {
        API_URL,
        normalizeLiveQuestion,
        normalizeCategory,
        fetchLiveQuestions
    };
}));
