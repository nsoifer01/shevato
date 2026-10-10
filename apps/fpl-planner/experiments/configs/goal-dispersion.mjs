// Conway-Maxwell-Poisson team goals: the same expected goals, a narrower count.
//
// WHAT CHANGES. With planOptions.modelOptions.goalDispersion = nu, every team
// goal count the fixture model and the player projections use is CMP with the
// model's expected goals as its MEAN (fixtures.js goalCountVector; the rate is
// solved so the mean is unchanged to 1e-12). Only the shape moves: P(0 goals
// conceded), so clean sheets, and the goals-conceded penalty. nu = 1 is the
// shipped Poisson bit for bit.
//
// At nu 1.16 a clean sheet becomes less likely at every expectation that
// matters, and more so the stronger the opponent: P(0) falls about 3% at an
// opponent xG of 0.8, 8% at 1.4 and 20% at 2.6. So it is partly a LEVEL change
// on defenders and goalkeepers against everyone else, and partly an ORDER
// change among defenders (easy fixtures relatively favoured).
//
// THE PARAMETER, fitted on PREDICTION targets only
// (scripts/calibration/calibrate-goal-model.mjs: maximum likelihood of observed
// team goals given the model's expected goals at each deadline, production
// regime): leave-one-season-out nu 1.17 / 1.16 / 1.15 for held-out 2023-24 /
// 2024-25 / 2025-26, full fit 1.16 (1.20 on the market's means). AIrsenal
// measured about 1.17. Held out, CMP beats Poisson by +0.0020 / +0.0022 /
// +0.0022 log-likelihood per side, positive in all three; clean-sheet expected
// calibration error 0.038 -> 0.023, 0.022 -> 0.024, 0.037 -> 0.021; clean-sheet
// Brier 0.1545 -> 0.1538, 0.1688 -> 0.1691, 0.1815 -> 0.1816 (mixed and tiny).
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), production regime,
//     exposure 2023-24, 2024-25, 2025-26.
//   - PRIMARY, nu116 vs control: ACCEPT iff the per-window mean has t >= 2.0
//     AND no exposed season mean is below -15 a window.
//   - INCONCLUSIVE iff 1.0 <= t < 2.0 with no season below -15. REJECT
//     otherwise, including any season below -15 whatever t says.
//   - Hits and transfers are reported as a sanity counter: a lower clean-sheet
//     level moves defenders against midfielders, and a candidate whose hits
//     rise by more than a quarter is INCONCLUSIVE at best until explained
//     (registry entry 12: a level correction crosses the hit threshold).
//   - No second nu is run on planner points; the parameter is the prediction
//     fit, and a sweep on points would be fitting the noise.
//
// REFUSES TO RUN while the switch is inert: the projections must read the
// dispersion (projections.js computes clean sheets and goals conceded itself),
// which is checked below on the shipped sample data before any arm starts.
//
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/goal-dispersion.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { assembleSampleBundle } from '../../js/data/sample.js';
import { buildGameState } from '../../js/engine/normalize.js';
import { buildStrength } from '../../js/engine/strength.js';
import { buildProjections } from '../../js/engine/projections.js';

const NU = 1.16;
const SEASONS = ['2023-24', '2024-25', '2025-26'];

function dispersionReachesProjections() {
  const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'data', 'sample');
  const files = ['meta', 'bootstrap', 'fixtures', 'entry', 'entry-history', 'entry-transfers', 'entry-picks'];
  const bundle = assembleSampleBundle(Object.fromEntries(files.map(f => [f, JSON.parse(fs.readFileSync(path.join(dir, `${f}.json`), 'utf8'))])));
  const gameState = buildGameState(bundle.bootstrap, bundle.fixtures, { fetchedAt: bundle.fetchedAt });
  const gw = gameState.nextEvent;
  const defenders = [...gameState.players.values()].filter(p => p.position === 2 || p.position === 1).slice(0, 40).map(p => p.id);
  const xp = (modelOptions) => {
    const strength = buildStrength(gameState, { asOfGw: gw, modelOptions });
    const p = buildProjections({ gameState, strength, gwFrom: gw, gwTo: gw, playerIds: defenders, modelOptions });
    return defenders.map(id => p.get(id, gw).xPoints);
  };
  const a = xp({});
  const b = xp({ goalDispersion: NU });
  return a.some((v, i) => v !== b[i]);
}

if (!dispersionReachesProjections()) {
  throw new Error('goal-dispersion: projections.js does not read modelOptions.goalDispersion yet, so the candidate arm would replay the control exactly. Wire it first (fixtures.js goalCountVector / pZeroGoals / goalDispersionOf).');
}

export default {
  name: 'goal dispersion',
  question: 'Do Conway-Maxwell-Poisson team goals (nu 1.16, same means) beat Poisson on planner points?',
  instrument: 'paired',
  seasons: SEASONS,
  exposure: { seasons: SEASONS },
  arms: [
    { name: 'control', description: 'Poisson team goals (the shipped fixture model)' },
    { name: 'nu116', description: `CMP nu ${NU}, the leave-one-season-out prediction fit`, opts: { planOptions: { modelOptions: { goalDispersion: NU } } } },
  ],
};
