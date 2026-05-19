'use strict';

// URL-safe slug from an exercise name. Lowercase ASCII letters and digits,
// dashes between words, capped at 80 chars. The caller is responsible for
// disambiguating colliding slugs (a few names like "Cable Y Raise" appear
// twice under different muscle groups — see assignSlugs below).
function slugify(name) {
  if (!name || typeof name !== 'string') return 'exercise';
  let s = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  if (s.length > 80) s = s.slice(0, 80).replace(/-+$/, '');
  return s || 'exercise';
}

// Assign a unique slug per exercise. The common case is the clean
// slug from the name. The rare collisions (a handful of "Cable Y
// Raise"-style duplicates) get the exercise id suffixed so URLs are
// stable and unique. Returns a Map<id, slug>.
function assignSlugs(exercises) {
  const baseCount = new Map();
  for (const ex of exercises) {
    const base = slugify(ex.name);
    baseCount.set(base, (baseCount.get(base) || 0) + 1);
  }
  const out = new Map();
  for (const ex of exercises) {
    const base = slugify(ex.name);
    out.set(ex.id, baseCount.get(base) > 1 ? `${base}-${ex.id}` : base);
  }
  return out;
}

module.exports = { slugify, assignSlugs };
