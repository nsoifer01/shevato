/**
 * Exercise search - normalisation + relevance ranking.
 *
 * The old search was `name.toLowerCase().includes(term) ||
 * muscleGroup.toLowerCase().includes(term)`. Against a 514-exercise catalog
 * that produced (GT-24):
 *
 *   "pull up"          → 0 results   (the catalog spells it "Pull-Ups")
 *   "pullup"           → 0 results
 *   "triceps pushdown" → 0 results   ("Cable Rope Pushdown", category triceps)
 *   "row"              → "Nar-ROW- Chest Press Machine" first
 *   "plank"            → the exercise literally called "Plank" fifth
 *
 * Two independent problems: MATCHING (a naive substring can't see that
 * "pull up", "pullup" and "pull-up" are the same word, and can't combine a
 * name word with a category word) and RANKING (an accidental substring inside
 * another word outranked an exact name).
 *
 * The fix is deliberately small and deterministic - no fuzzy distance, no
 * stemming library, nothing that would make "why did that rank there?"
 * unanswerable:
 *
 *   1. Normalise both sides: lowercase, strip punctuation/apostrophes, fold
 *      hyphens and underscores to spaces, collapse whitespace, and drop a
 *      trailing plural "s" per token, so "Pull-Ups", "pull up" and "pullup"
 *      all reach the same token list ["pull", "up"] (the no-space spelling
 *      via `matchesTokenRun`).
 *   2. Score every query TERM against the exercise's fields, and require
 *      EVERY term to match something. That is what makes "triceps pushdown"
 *      work: "pushdown" hits the name, "triceps" hits the category.
 *   3. Rank by match quality, not by catalog position: exact name, then name
 *      prefix, then whole-word name match, then other fields, and finally
 *      mid-word substrings - which score low enough that "Narrow" can never
 *      outrank a real "Row".
 *
 * Used by the Exercise Database, the program exercise picker and the
 * in-workout swap picker so all three behave identically.
 */

/** Score bands. Higher is better; every term's best band is summed. */
const SCORE = {
    EXACT_NAME: 1000,
    NAME_PREFIX: 400,
    NAME_WORD: 300,
    NAME_WORD_START: 260,
    SQUASHED_NAME: 180,
    META_WORD: 90,
    META_PREFIX: 70,
    NAME_SUBSTRING: 30,
    META_SUBSTRING: 10,
};

/**
 * Lowercase, drop punctuation, fold separators to single spaces.
 * "21s Barbell Curl" → "21s barbell curl"; "Pull-Ups" → "pull ups".
 */
export function normalizeSearchText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/['’`]/g, '')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/**
 * Drop one trailing plural "s" from a token: "ups" → "up", "dips" → "dip".
 * Applied to BOTH sides of every comparison, so even an over-eager strip
 * ("abs" → "ab") stays self-consistent and cannot lose a match. Words ending
 * in "ss" ("press") and two-letter tokens are left alone.
 */
function singular(token) {
    if (token.length > 2 && token.endsWith('s') && !token.endsWith('ss')) {
        return token.slice(0, -1);
    }
    return token;
}

/** Normalised, singularised token list. '' yields []. */
export function tokenize(value) {
    const norm = normalizeSearchText(value);
    if (!norm) return [];
    return norm.split(' ').filter(Boolean).map(singular);
}

/**
 * Everything about an exercise a query term is allowed to match, split into
 * the name (high value) and the metadata a user might reasonably type
 * (category, muscle group, equipment).
 */
function searchFields(exercise) {
    const name = normalizeSearchText(exercise?.name);
    const meta = [exercise?.category, exercise?.muscleGroup, exercise?.equipment]
        .map(normalizeSearchText)
        .filter(Boolean)
        .join(' ');
    return { name, meta };
}

/**
 * True when `term` is the concatenation of one or more CONSECUTIVE name
 * tokens: "pullup" over ["pull", "up"], "benchpress" over
 * ["barbell", "bench", "press"]. Anchored at token boundaries, so it can
 * never fire on an accidental substring inside a single word.
 */
function matchesTokenRun(term, nameTokens) {
    if (!term || nameTokens.length < 2) return false;
    for (let i = 0; i < nameTokens.length; i++) {
        let acc = '';
        for (let j = i; j < nameTokens.length; j++) {
            acc += nameTokens[j];
            if (acc === term) return j > i; // a single token is handled above
            if (!term.startsWith(acc)) break;
        }
    }
    return false;
}

/** Best score one query term can earn against one exercise. 0 = no match. */
function scoreTerm(term, fields, nameTokens, metaTokens) {
    if (!term) return 0;

    // Whole-word hits on the name.
    for (const token of nameTokens) {
        if (token === term) return SCORE.NAME_WORD;
        if (token.startsWith(term)) return SCORE.NAME_WORD_START;
    }
    // "pullup" / "benchpress": the term is a run of consecutive name words
    // written without the separator. Anchored to word boundaries on purpose:
    // a bare `squashedName.includes(term)` would let "row" match
    // "Nar-row- Chest Press Machine" at full strength, which is the exact
    // mis-ranking this module exists to remove.
    if (matchesTokenRun(term, nameTokens)) return SCORE.SQUASHED_NAME;
    // Whole-word hits on category / muscle / equipment.
    for (const token of metaTokens) {
        if (token === term) return SCORE.META_WORD;
        if (token.startsWith(term)) return SCORE.META_PREFIX;
    }
    // Last resort: a substring sitting inside another word ("row" in
    // "narrow"). Deliberately worth almost nothing so it can only ever act as
    // a tie-breaker among results that already matched properly.
    if (fields.name.includes(term)) return SCORE.NAME_SUBSTRING;
    if (fields.meta.includes(term)) return SCORE.META_SUBSTRING;
    return 0;
}

/**
 * Relevance of one exercise for one query. Returns 0 when ANY query term
 * fails to match, so results always satisfy the whole query.
 */
export function scoreExercise(exercise, query) {
    const terms = tokenize(query);
    if (terms.length === 0) return 1; // empty query matches everything

    const fields = searchFields(exercise);
    if (!fields.name && !fields.meta) return 0;

    const nameTokens = fields.name.split(' ').filter(Boolean).map(singular);
    const metaTokens = fields.meta.split(' ').filter(Boolean).map(singular);

    const normQuery = normalizeSearchText(query);
    const normName = fields.name;
    const queryTokens = normQuery.split(' ').filter(Boolean).map(singular).join(' ');
    const nameSingular = nameTokens.join(' ');

    let total = 0;
    for (const term of terms) {
        const s = scoreTerm(term, fields, nameTokens, metaTokens);
        if (s === 0) return 0;
        total += s;
    }

    // Whole-query bonuses, applied once.
    const squashedName = nameTokens.join('');
    const squashedQuery = terms.join('');
    if (nameSingular === queryTokens || normName === normQuery
        || squashedName === squashedQuery) {
        total += SCORE.EXACT_NAME;
    } else if (nameSingular.startsWith(`${queryTokens} `) || normName.startsWith(`${normQuery} `)) {
        // Whole-WORD prefix only. A raw string prefix would hand "Rowing
        // Machine" the bonus for the query "row" and push the actual rows
        // below it.
        total += SCORE.NAME_PREFIX;
    }

    return total;
}

/** True when the exercise satisfies every term of the query. */
export function matchesQuery(exercise, query) {
    return scoreExercise(exercise, query) > 0;
}

/**
 * Filter + rank a catalog for a query.
 *
 * With an empty query the input order is preserved untouched (callers apply
 * their own A-Z / most-logged sort). With a query, results come back best
 * first, ties broken alphabetically so the order is stable and predictable.
 */
export function searchExercises(exercises, query) {
    const list = Array.isArray(exercises) ? exercises : [];
    if (tokenize(query).length === 0) return list.slice();

    return list
        .map(exercise => ({ exercise, score: scoreExercise(exercise, query) }))
        .filter(entry => entry.score > 0)
        .sort((a, b) => (
            b.score - a.score
            || String(a.exercise.name || '').localeCompare(String(b.exercise.name || ''))
        ))
        .map(entry => entry.exercise);
}
