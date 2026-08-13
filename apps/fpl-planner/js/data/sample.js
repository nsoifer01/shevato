// The ?demo=1 SAMPLE dataset.
//
// WHY IT EXISTS: the 2026/27 season has not kicked off, so no gameweek is
// current, `entry/{id}/event/{gw}/picks` 404s for every gameweek, and the whole
// in-season experience (a real squad, banked transfers, spent chips, an injured
// starter, a blank and a double gameweek) is untestable against live data. This
// bundle is a synthetic in-season snapshot built from the real payload shapes.
//
// IT IS NEVER A FALLBACK. Nothing in this app may load it because a live fetch
// failed: a fabricated squad presented as the user's own is the worst failure
// this app could have. It loads only when the URL explicitly asks for it, and
// every payload, the bundle and the data-status panel all carry `sample: true`.
//
// STORAGE FORMAT: players and fixtures are stored as a column table (field
// names once, one row per record) purely for size. expandTable() restores the
// exact upstream shape before anything else sees the data.

const SAMPLE_FILES = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];

export function isDemoRequested(search) {
  const params = new URLSearchParams(search || '');
  return params.get('demo') === '1';
}

export function expandTable(table) {
  if (!table || !Array.isArray(table.fields) || !Array.isArray(table.rows)) return [];
  const { fields, rows } = table;
  return rows.map(row => {
    const out = {};
    for (let i = 0; i < fields.length; i++) out[fields[i]] = row[i];
    return out;
  });
}

// Pure: takes the seven parsed files and returns the bundle the app runs on.
export function assembleSampleBundle(files) {
  const meta = files.meta;
  const bootstrap = {
    sample: true,
    chips: files.bootstrap.chips,
    events: files.bootstrap.events,
    game_settings: files.bootstrap.game_settings,
    game_config: files.bootstrap.game_config,
    teams: files.bootstrap.teams,
    element_types: files.bootstrap.element_types,
    total_players: files.bootstrap.total_players,
    elements: expandTable(files.bootstrap.elementsTable),
  };
  const fixtures = expandTable(files.fixtures);
  const entry = files.entry;
  const history = files['entry-history'];
  const transfers = files['entry-transfers'];
  const picks = files['entry-picks'];

  return {
    sample: true,
    label: meta.label,
    meta,
    fetchedAt: meta.fetchedAt,
    entryId: meta.entryId,
    currentEvent: meta.currentEvent,
    planEvent: meta.planEvent,
    bootstrap,
    fixtures,
    entry,
    history,
    transfers,
    picks,
    // Keyed by the same paths the live client uses, so api.useSampleData()
    // can serve the demo through exactly one code path.
    byPath: {
      'bootstrap-static': bootstrap,
      fixtures,
      [`entry/${meta.entryId}`]: entry,
      [`entry/${meta.entryId}/history`]: history,
      [`entry/${meta.entryId}/transfers`]: transfers,
      [`entry/${meta.entryId}/event/${meta.currentEvent}/picks`]: picks,
    },
  };
}

export async function loadSampleData({ basePath, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const base = basePath || new URL('../../data/sample/', import.meta.url).href;
  const entries = await Promise.all(SAMPLE_FILES.map(async name => {
    const res = await doFetch(`${base}${name}.json`);
    if (!res.ok) throw new Error(`sample data ${name}.json: ${res.status}`);
    return [name, await res.json()];
  }));
  return assembleSampleBundle(Object.fromEntries(entries));
}
