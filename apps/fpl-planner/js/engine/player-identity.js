// Canonical cross-season player identity.
//
// THE BUG THIS MODULE EXISTS TO PREVENT
//
// FPL reassigns `element` every season. It is a row number in that season's
// bootstrap, not a player. Measured on the four seasons in .data/, an element id
// that appears in two consecutive seasons refers to the SAME player in 0.0% to
// 0.13% of cases:
//
//   2022-23 -> 2023-24   777 shared ids, 1 is the same player  (0.13%)
//   2023-24 -> 2024-25   803 shared ids, 0 are the same player (0.00%)
//   2024-25 -> 2025-26   804 shared ids, 1 is the same player  (0.12%)
//
// So a season-to-season join on `element` is not a lossy join, it is a
// SHUFFLE. It reports a plausible-looking number for every player and every one
// of them is a different footballer. The way this was found: regressing a
// player's start rate in season N+1 on his start rate in season N gave a slope
// of 0.017 joined on `element` against 0.691 joined on name, and start rate is
// one of the most persistent quantities in the sport. A wrong join does not fail
// loudly, it returns noise with the right shape.
//
// THE CANONICAL IDENTIFIER IS `code`, AND THAT IS MEASURED, NOT ASSUMED
//
// `code` is FPL's permanent per-player id. Verified against the same four
// seasons via players_raw.csv: every code shared by two consecutive seasons
// names the same footballer. The raw string equality of the full name is 89.7%
// to 97.3%, and every single disagreement is the same human under a different
// spelling, never two people:
//
//   code 91651   "Mateo Kovacic"     -> "Mateo Kovačić"          (accent restored)
//   code 223723  "Takehiro Tomiyasu" -> "Tomiyasu Takehiro"      (name order)
//   code 221466  "Marcos Senesi"     -> "Marcos Senesi Barón"    (surname added)
//   code 214048  "Max Kilman"        -> "Maximilian Kilman"      (given name expanded)
//
// That list is also the reason a name join is a fallback and not the answer.
//
// WHERE `code` LIVES, AND WHERE IT DOES NOT
//
// `merged_gw.csv`, the per-gameweek archive the replay and the trainer read,
// does NOT carry `code`. Its identity columns are `element`, `name`, `team` and
// `position` in all four seasons, checked against the real headers. The same
// upstream archive publishes `players_raw.csv` per season, which carries BOTH
// `id` (equal to merged_gw's `element`) and `code`, and joining the two inside
// one season agrees on the player's name for 3,287 of 3,288 elements across the
// four seasons. That file is the bridge: element + season -> code.
//
// The live FPL API carries `code` on every element directly, so nothing in the
// browser needs this bridge.
//
// WHY THE FALLBACK MAY NOT USE A CLUB CONSTRAINT
//
// The availability join in backtest.js constrains every rung to the club, which
// is correct THERE because it matches two views of the same season. This join
// crosses seasons, and players transfer. Requiring the club to agree would drop
// every summer signing, which is a large and non-random slice of exactly the
// players whose prior season matters most. Club is therefore only ever used to
// break a tie, never to require one.

// ---------------------------------------------------------------------------
// Season-scoped fields, named so a cross-season join can refuse them
// ---------------------------------------------------------------------------

export const CANONICAL_ID_FIELD = 'code';

// Every spelling of "this season's row number" that appears in the FPL API, the
// archive, or this codebase. None of them may key a join that crosses a season.
export const SEASON_SCOPED_ID_FIELDS = Object.freeze([
  'element', 'element_id', 'id', 'playerId', 'player_id', 'playerKey', 'opponent_team',
]);

export function isSeasonScopedField(field) {
  return SEASON_SCOPED_ID_FIELDS.includes(String(field));
}

// A hard refusal, not a warning. Called by anything that is about to key a
// cross-season structure, so the wrong key fails at the join instead of
// producing a number nobody can tell is wrong.
export function assertCrossSeasonField(field) {
  if (isSeasonScopedField(field)) {
    throw new Error(
      `player-identity: "${field}" is scoped to one season and cannot key a cross-season join. `
      + `FPL reassigns it every year, so the join would match different players (measured: 0.0-0.13% `
      + `of shared element ids are the same footballer). Use "${CANONICAL_ID_FIELD}", or resolveSeasonPair() `
      + 'for archive rows that carry no code.',
    );
  }
  return field;
}

// The key a cross-season structure is allowed to use. Refuses rather than
// falling back to the id, because a silent fallback is how the original bug
// would come back.
export function crossSeasonKey(player) {
  const code = player == null ? null : player.code;
  if (!Number.isFinite(Number(code)) || Number(code) <= 0) {
    throw new Error(
      'player-identity: crossSeasonKey needs a canonical `code`. '
      + `Got ${JSON.stringify(code)} for ${JSON.stringify(player && player.name)}. `
      + 'An element id is not a substitute for it.',
    );
  }
  return Number(code);
}

// ---------------------------------------------------------------------------
// Name normalization
//
// Shared with the availability join in backtest.js on purpose: two copies of
// accent folding drift apart, and the drift is invisible until a join quietly
// stops matching somebody.
// ---------------------------------------------------------------------------

// Letters that carry no combining mark to strip, so NFD leaves them whole and
// the a-z filter below would DELETE them. Without this line "Højlund" becomes
// "hjlund", matches nothing, and a top-six striker goes missing.
const LETTER_FOLDS = [
  [/ø/g, 'o'], [/æ/g, 'ae'], [/œ/g, 'oe'], [/ß/g, 'ss'],
  [/ð/g, 'd'], [/þ/g, 'th'], [/ł/g, 'l'], [/đ/g, 'd'], [/ı/g, 'i'],
];

export function normalizeName(name) {
  let out = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  for (const [pattern, replacement] of LETTER_FOLDS) out = out.replace(pattern, replacement);
  return out
    .replace(/[^a-z0-9 .-]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Particles identify nobody. "de", "da", "van" and friends must never be the
// single token two names are matched on.
const PARTICLES = new Set(['de', 'da', 'do', 'dos', 'das', 'du', 'del', 'della', 'di',
  'van', 'von', 'der', 'den', 'ter', 'la', 'le', 'el', 'al', 'bin', 'ben', 'junior', 'jr', 'santos']);

// The order-free identifying token set: hyphens split like spaces, particles and
// single letters dropped. "Kaine Kesler-Hayden" and "Kaine Kesler Hayden" both
// give {kaine, kesler, hayden}, which is the point.
//
// The double-barrelled JOINED form is deliberately NOT kept. Keeping it made
// "Kyle Walker-Peters" share two tokens with "Kyle Walker" and match him, and
// those are two different footballers.
export function nameTokens(name) {
  const tokens = normalizeName(name).split(/[ -]+/).map(t => t.replace(/\./g, '')).filter(Boolean);
  return new Set(tokens);
}

const identifying = (tokens) => [...tokens].filter(t => !PARTICLES.has(t) && t.length > 1);

// ---------------------------------------------------------------------------
// The element -> code bridge, built from one season's players_raw.csv
// ---------------------------------------------------------------------------

export function parseCsv(text) {
  const rows = [];
  let field = '';
  let record = [];
  let inQuotes = false;
  const pushField = () => { record.push(field); field = ''; };
  const pushRecord = () => {
    if (!(record.length === 1 && record[0] === '')) rows.push(record);
    record = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQuotes = false;
      } else field += c;
    } else if (c === '"') inQuotes = true;
    else if (c === ',') pushField();
    else if (c === '\n') { pushField(); pushRecord(); }
    else if (c !== '\r') field += c;
  }
  if (field.length || record.length) { pushField(); pushRecord(); }
  const header = rows.shift() || [];
  return rows
    .filter(r => r.length === header.length)
    .map(r => Object.fromEntries(header.map((h, i) => [h.trim(), r[i]])));
}

export const IDENTITY_REQUIRED_COLUMNS = Object.freeze(['id', 'code', 'first_name', 'second_name']);

// One season's identity table. `codeByElement` is the only thing the rest of the
// codebase needs; the names come along so a resolution can be explained.
export function buildIdentityIndex(csvText, { season } = {}) {
  const rows = parseCsv(csvText);
  if (!rows.length) throw new Error(`player-identity: the identity table for ${season} parsed to zero rows.`);
  const missing = IDENTITY_REQUIRED_COLUMNS.filter(c => !(c in rows[0]));
  if (missing.length) {
    throw new Error(
      `player-identity: the identity table for ${season} is missing ${missing.join(', ')}. `
      + 'Without `code` there is no canonical cross-season identity and the join must not proceed.',
    );
  }

  const codeByElement = new Map();
  const nameByCode = new Map();
  for (const row of rows) {
    const element = Number(row.id);
    const code = Number(row.code);
    if (!Number.isFinite(element) || !Number.isFinite(code) || code <= 0) continue;
    codeByElement.set(element, code);
    nameByCode.set(code, `${row.first_name} ${row.second_name}`.trim());
  }
  if (codeByElement.size !== nameByCode.size) {
    throw new Error(
      `player-identity: ${season} has ${codeByElement.size} elements sharing ${nameByCode.size} codes. `
      + 'Two elements with one code inside a season means the identity table is not what this assumes.',
    );
  }
  return { season, codeByElement, nameByCode, size: codeByElement.size };
}

// ---------------------------------------------------------------------------
// Cross-season resolution
//
// A roster is [{ id, name, code }] for one season. `id` is carried so the caller
// can map an answer back to its own structures; it is NEVER compared, and a test
// pins that.
// ---------------------------------------------------------------------------

function rosterEntry(player) {
  const code = Number(player.code);
  const tokens = nameTokens(player.name);
  return {
    id: player.id,
    name: player.name,
    code: Number.isFinite(code) && code > 0 ? code : null,
    full: normalizeName(player.name),
    tokens,
    identifying: new Set(identifying(tokens)),
  };
}

function uniqueBy(list, keyOf) {
  const groups = new Map();
  for (const entry of list) {
    const key = keyOf(entry);
    if (key === null || key === undefined || key === '') continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  return groups;
}

const sameSet = (a, b) => a.size === b.size && [...a].every(t => b.has(t));

// Resolve the players of `to` back to the players of `from`.
//
// Rung 1 is `code`, which is exact and needs no heuristics at all. Everything
// below it exists for rows that carry no code: synthetic seasons in tests, and
// any archive season whose identity table has not been downloaded.
//
// EVERY name rung requires a UNIQUE candidate on BOTH sides. Two players who
// answer to one name are reported as a collision and left unresolved, because a
// wrong cross-season match seeds one footballer's history onto another and
// nothing downstream can tell.
export function resolveSeasonPair({ from, to }) {
  if (!from || !to) throw new Error('player-identity: resolveSeasonPair needs both a from and a to roster.');
  if (from.season && to.season && from.season === to.season) {
    throw new Error(
      `player-identity: resolveSeasonPair was given ${from.season} on both sides. `
      + 'A cross-season resolver is the wrong tool for a within-season join, which may use element ids directly.',
    );
  }

  const fromEntries = from.players.map(rosterEntry);
  const toEntries = to.players.map(rosterEntry);

  const fromByCode = new Map();
  for (const entry of fromEntries) if (entry.code !== null) fromByCode.set(entry.code, entry);
  const fromHasCodes = fromByCode.size > 0;

  const matched = new Map();     // to.id -> from entry
  const method = new Map();      // to.id -> which rung
  const collisions = [];
  const unmatched = [];
  const stats = { code: 0, name: 0, tokenSet: 0 };
  let newcomers = 0;

  const pending = [];
  for (const entry of toEntries) {
    if (entry.code !== null && fromByCode.has(entry.code)) {
      matched.set(entry.id, fromByCode.get(entry.code));
      method.set(entry.id, 'code');
      stats.code++;
    } else if (entry.code !== null && fromHasCodes) {
      // Both sides carry codes and this one is absent from the other season, so
      // he is a definite newcomer rather than a join failure. Counting him as
      // unmatched would understate a match rate that is in fact complete.
      newcomers++;
    } else {
      pending.push(entry);
    }
  }

  if (pending.length) {
    const takenIds = new Set([...matched.values()].map(e => e.id));
    const pool = fromEntries.filter(e => !takenIds.has(e.id));
    const byFull = uniqueBy(pool, e => e.full);

    for (const entry of pending) {
      // Two rungs, and there is deliberately no third.
      //
      // A "one name's tokens are a subset of the other's" rung was built,
      // measured and REMOVED. It bought 50 extra matches across the three season
      // pairs and paid for them with three wrong ones: it married "Kyle Walker"
      // to "Kyle Walker-Peters" and "Victor da Silva" to "João Victor Gomes da
      // Silva". A wrong cross-season match seeds one footballer's entire
      // previous season onto another and nothing downstream can detect it, while
      // a missed match only means a player starts with no history, which is the
      // behaviour that already existed. The asymmetry decides it.
      const rungs = [
        ['name', () => byFull.get(entry.full) || []],
        ['tokenSet', () => pool.filter(c => sameSet(c.identifying, entry.identifying))],
      ];

      let resolved = false;
      for (const [rung, candidatesOf] of rungs) {
        const hits = candidatesOf();
        if (hits.length === 1) {
          matched.set(entry.id, hits[0]);
          method.set(entry.id, rung);
          stats[rung]++;
          resolved = true;
          break;
        }
        if (hits.length > 1) {
          collisions.push({
            name: entry.name,
            rung,
            candidates: hits.map(h => h.name),
          });
          resolved = true;
          break;
        }
      }
      if (!resolved) unmatched.push({ name: entry.name, reason: 'no-match' });
    }

    // The same collision seen from the other side. Each rung demands a unique
    // candidate in the season being joined FROM, which stops one name matching
    // two players; it does not stop two different players in the season being
    // joined TO from both matching one player. That is the same ambiguity and
    // gets the same answer: report it, resolve neither.
    //
    // It does not occur on the four seasons currently held. It is guarded
    // anyway, because "the data happened to be kind" is not a property of the
    // resolver.
    const claims = new Map();
    for (const [toId, fromEntry] of matched) {
      if (method.get(toId) === 'code') continue;
      if (!claims.has(fromEntry.id)) claims.set(fromEntry.id, []);
      claims.get(fromEntry.id).push(toId);
    }
    for (const [fromId, toIds] of claims) {
      if (toIds.length < 2) continue;
      const contested = fromEntries.find(e => e.id === fromId);
      for (const toId of toIds) {
        stats[method.get(toId)]--;
        matched.delete(toId);
        method.delete(toId);
      }
      collisions.push({
        name: contested.name,
        rung: 'many-to-one',
        candidates: toIds.map(id => toEntries.find(e => e.id === id).name),
      });
    }
  }

  const collided = new Set(collisions.map(c => c.name));
  return {
    from: from.season,
    to: to.season,
    matched,
    method,
    stats: {
      byRung: { ...stats },
      candidates: toEntries.length,
      resolved: matched.size,
      newcomers,
      collisions: collisions.length,
      unresolved: unmatched.filter(u => !collided.has(u.name)).length,
      collisionSample: collisions.slice(0, 10),
      unresolvedSample: unmatched.slice(0, 10),
    },
  };
}
