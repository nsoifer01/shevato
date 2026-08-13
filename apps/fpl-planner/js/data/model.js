// The trained model artifact, loaded at boot.
//
// WHY THIS FILE EXISTS: scripts/train-model.mjs writes a versioned artifact into
// models/ and records it in models/index.json, and projections.js has a seam
// that consumes one. Nothing connected the two, so every plan ran on the
// analytic priors and the training pipeline was decoration. This is the join.
//
// THE CURRENT MODEL IS RESOLVED, NOT HARDCODED. index.json is the register and
// the highest version in it wins, so the next retrain is picked up by shipping a
// file, with no code edit and no version string to forget.
//
// ONLY WHAT THE ARTIFACT DECLARES. An artifact says which of its parts the
// engine may use in `engineConsumes`, and nothing outside that list is passed
// on. The v2 artifact currently declares NOTHING. Its start calibrator improves
// start-probability calibration on held-out data and still lost season points in
// two leakage-free full-season replays (2024-25 planner 2371 to 2211, 2023-24
// planner 1943 to 1853, and the greedy baseline lost in both too), so the
// artifact's own `engineConsumesDisabledBecause` field carries the numbers and
// the list is empty. The calibrator stays in the file so the decision can be
// re-tested; it is simply not fed to anything.
//
// SO THERE ARE THREE STATES, NOT TWO. Loaded and consumed; loaded and
// deliberately consuming nothing; not available at all. The middle one is a
// healthy state, not a failure: `ok` is true, `consumed` is empty and `model` is
// null, so the engine gets no model at all and reports the analytic version
// rather than claiming this artifact produced the plan.
//
// FAILING TO LOAD IS NOT AN ERROR EITHER. A missing, unreachable or malformed
// artifact returns ok:false with a reason, the planner falls back to the
// analytic priors, and the model and data status panel says which of the three
// states it is in.

export const MODEL_INDEX_FILE = 'index.json';

// The parts of an artifact this engine has a seam for, each with the check its
// value has to pass. A key an artifact declares that is not here is ignored: a
// future artifact may offer more than this version of the engine can use.
const CONSUMABLES = {
  startCalibratorJSON: {
    label: 'start probabilities calibrated',
    valid: isCalibrator,
  },
};

function isCalibrator(value) {
  if (!value || typeof value !== 'object') return false;
  if (value.method === 'platt') return Number.isFinite(value.a) && Number.isFinite(value.b);
  if (value.method === 'bins') {
    return Array.isArray(value.points)
      && value.points.length > 0
      && value.points.every(p => p && Number.isFinite(p.x) && Number.isFinite(p.y));
  }
  return false;
}

function failure(reason) {
  return { ok: false, model: null, modelVersion: null, consumed: [], reason };
}

// The register's newest entry. Version numbers only ever go up (train-model.mjs
// appends, it never overwrites), so the highest one is the current model.
export function currentEntry(index) {
  const models = index && Array.isArray(index.models) ? index.models : [];
  let best = null;
  for (const entry of models) {
    if (!entry || typeof entry.file !== 'string' || !entry.file) continue;
    if (!Number.isFinite(entry.version)) continue;
    if (!best || entry.version > best.version) best = entry;
  }
  return best;
}

// Turn a parsed artifact into the object planner options carry, or say why not.
export function selectModel(artifact) {
  if (!artifact || typeof artifact !== 'object') return failure('the artifact is not an object');

  const modelVersion = typeof artifact.modelVersion === 'string' ? artifact.modelVersion.trim() : '';
  if (!modelVersion) return failure('the artifact carries no modelVersion');
  if (!Array.isArray(artifact.engineConsumes)) return failure(`${modelVersion} declares no engineConsumes list`);

  const model = { modelVersion };
  const consumed = [];
  for (const key of artifact.engineConsumes) {
    const spec = CONSUMABLES[key];
    if (!spec) continue;
    if (!spec.valid(artifact[key])) return failure(`${modelVersion} has a malformed ${key}`);
    model[key] = artifact[key];
    consumed.push(key);
  }

  // Nothing to consume, so nothing is handed over: `model` is null rather than a
  // bare `{ modelVersion }`, because projections.js reports whatever version it
  // is given, and a plan built entirely on the analytic priors must not come out
  // labelled with this artifact's name.
  if (!consumed.length) return { ok: true, model: null, modelVersion, consumed: [], reason: null };

  return { ok: true, model, modelVersion, consumed, reason: null };
}

export async function loadModel({ basePath, fetchImpl } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const base = basePath || new URL('../../models/', import.meta.url).href;

  let index;
  try {
    const res = await doFetch(`${base}${MODEL_INDEX_FILE}`);
    if (!res.ok) return failure(`models/${MODEL_INDEX_FILE} returned ${res.status}`);
    index = await res.json();
  } catch (err) {
    return failure(`models/${MODEL_INDEX_FILE} could not be read: ${err.message}`);
  }

  const entry = currentEntry(index);
  if (!entry) return failure(`models/${MODEL_INDEX_FILE} lists no usable model`);

  let artifact;
  try {
    const res = await doFetch(`${base}${entry.file}`);
    if (!res.ok) return failure(`models/${entry.file} returned ${res.status}`);
    artifact = await res.json();
  } catch (err) {
    return failure(`models/${entry.file} could not be read: ${err.message}`);
  }

  return selectModel(artifact);
}

// What the model and data status panel says, one line per state. The panel has
// to tell all three apart, because "the trained model produced this plan", "the
// trained model is on the shelf and was deliberately not used" and "the trained
// model was not there at all" are three different products, and a plan built on
// the analytic priors looks exactly as confident as one built on a trained
// model either way.
export function describeModelStatus(status) {
  if (!status) return 'not checked';
  if (status.ok && status.consumed.length) {
    const parts = status.consumed.map(key => (CONSUMABLES[key] ? CONSUMABLES[key].label : key));
    return `${status.modelVersion}, ${parts.join(', ')}`;
  }
  if (status.ok) {
    return `${status.modelVersion} loaded, not used (it predicts who starts more accurately, but cost points when past seasons were replayed with it), so this plan uses the analytic priors`;
  }
  return `not loaded (${status.reason}), so this plan uses the analytic priors`;
}
