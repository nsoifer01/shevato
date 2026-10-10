// A start calibrator fitted on the engine's own start probability (2026-10-09
// pre-merge review, audit B15).
//
// WHY. The trained artifacts' calibrator was fitted on a DIFFERENT model's
// outputs (train-model.mjs's logistic start model) and is now refused by the
// engine. Whether a calibrator helps at all is answered here, with one fitted
// on the quantity it corrects: minutes.js's base start probability at each
// production-regime deadline (scripts/calibration/calibrate-start.mjs),
// monotone bins, leave-one-season-out, so each replayed season reads the
// calibrator fitted WITHOUT it.
//
// MEASURED BEFORE THIS REGISTRATION (held out, single-fixture gameweeks):
//   log loss 0.3685 -> 0.3649, 0.3418 -> 0.3382, 0.3556 -> 0.3536,
//   0.3314 -> 0.3277 (2022-23 to 2025-26); players predicted 0.9 or more to
//   start: shipped 0.942-0.946, calibrated 0.894-0.902, started 0.902-0.911.
//   It removes the top-bin over-confidence the calibration report found.
//
// PRE-REGISTERED, written before any arm ran:
//   - Instrument 3 (paired, 15 windows, chips off), exposure 2023-24, 2024-25,
//     2025-26.
//   - ACCEPT iff per-window t >= 2.0 AND no exposed season's mean below -15.
//     INCONCLUSIVE iff 1.0 <= t < 2.0. REJECT otherwise. Registry entry 2's
//     lesson stands: a better log loss is not a better team.
//
// Needs the fitted file:
//   node apps/fpl-planner/scripts/calibration/calibrate-start.mjs
//   node apps/fpl-planner/scripts/experiment.mjs --config apps/fpl-planner/experiments/configs/start-calibration.mjs

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '.data', 'calibration', 'start-calibration.json');
if (!fs.existsSync(FILE)) {
  throw new Error('start-calibration: run scripts/calibration/calibrate-start.mjs first');
}
const fitted = JSON.parse(fs.readFileSync(FILE, 'utf8'));

export default {
  name: 'start calibration',
  question: 'Does a start calibrator fitted on the engine\'s own start probability win planner points?',
  instrument: 'paired',
  exposure: { seasons: ['2023-24', '2024-25', '2025-26'] },
  arms: [
    { name: 'control', description: 'shipped: the analytic start probability, uncalibrated' },
    {
      name: 'calibrated',
      description: 'monotone-bin calibrator on the base start probability, held out by season',
      opts: { planOptions: { modelOptions: { startCalibration: { fittedOn: fitted.fittedOn, bySeason: fitted.methods.bins.bySeason } } } },
    },
  ],
};
