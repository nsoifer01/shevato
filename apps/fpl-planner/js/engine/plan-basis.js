// Which plan an answer was computed against.
//
// "Why not this player?" is answered in the worker against whichever plan the
// worker holds, and rendered on a page that may by then be showing another one:
// a refresh, a changed free-transfer count, a recalculation, or a run of the
// team sandbox, which uses the same worker. An answer is only true of the plan
// it was computed against, so it carries that plan's identity and the page
// refuses to show it under a plan with a different one.
//
// Kept in its own module so the page can check it without importing the
// optimizer.

// The error a question about a replaced plan is refused with, worker or inline.
export const STALE_PLAN = 'fpl-stale-plan';

const squadKey = ids => (ids || []).slice().sort((a, b) => a - b).join(',');

// The identity of the plan an answer describes. The page compares it with the
// plan it is showing and refuses a mismatch, so an answer computed against an
// older plan (a different free-transfer count, a refresh, a sandbox run) can
// never be displayed under a newer one.
export function planBasis(planBundle) {
  const plan = planBundle && planBundle.current;
  const squadState = planBundle && planBundle.squadState;
  if (!plan || !squadState) return null;
  return {
    gw: plan.gw,
    freeTransfers: Number.isFinite(squadState.freeTransfers) ? squadState.freeTransfers : null,
    bankTenths: squadState.bankTenths,
    squad: squadKey(plan.squad),
    transfersIn: (plan.transfersIn || []).slice(),
    transfersOut: (plan.transfersOut || []).slice(),
    xPointsHorizon: plan.xPointsHorizon,
  };
}

export function sameBasis(a, b) {
  if (!a || !b) return false;
  return a.gw === b.gw
    && a.freeTransfers === b.freeTransfers
    && a.bankTenths === b.bankTenths
    && a.squad === b.squad
    && a.transfersIn.join(',') === b.transfersIn.join(',')
    && a.transfersOut.join(',') === b.transfersOut.join(',')
    && Math.abs(a.xPointsHorizon - b.xPointsHorizon) < 1e-9;
}
