/**
 * Plate calculator — pure helpers.
 *
 * Given a target total weight, the bar weight, and the available plate
 * sizes, return the per-side plate stack that adds up to the closest
 * achievable weight ≤ target. Uses a greedy descent (always take the
 * heaviest plate that still fits) which is optimal for the standard
 * monotone-multiple plate set used in gyms.
 *
 * Returns:
 *   {
 *     achievable: number,          // total weight (bar + 2 × per side)
 *     perSide: number,             // weight on one sleeve
 *     plates: Array<{ weight: number, count: number }>,  // per side, descending
 *     diff: number,                // target − achievable, ≥ 0
 *     reachable: boolean,          // diff === 0
 *   }
 *
 * If the target is below the bar, returns { reachable: false, ... } with
 * a zero-plate stack and the bar's own weight as `achievable`.
 */

export function calculatePlates(target, barWeight, plates) {
    const targetN = Number(target);
    const barN = Number(barWeight);
    const plateList = Array.isArray(plates) ? plates : [];

    if (!Number.isFinite(targetN) || !Number.isFinite(barN) || barN < 0) {
        return invalid(targetN, barN);
    }

    // Below-bar target → unreachable; show bar-only.
    if (targetN < barN) {
        return {
            achievable: barN,
            perSide: 0,
            plates: [],
            diff: barN - targetN, // negative direction; we report magnitude
            reachable: targetN === barN,
            belowBar: true,
        };
    }

    const perSideTarget = (targetN - barN) / 2;

    // Sort descending and dedupe non-positive entries; greedy needs the
    // heaviest plate first.
    const sortedPlates = plateList
        .map(Number)
        .filter((n) => Number.isFinite(n) && n > 0)
        .sort((a, b) => b - a);

    let remaining = perSideTarget;
    const out = [];
    for (const plate of sortedPlates) {
        if (plate > remaining) continue;
        // Math.floor with a small epsilon so 17.5 / 2.5 = 7.0000…0001 still
        // gives the right count.
        const count = Math.floor((remaining + 1e-9) / plate);
        if (count > 0) {
            out.push({ weight: plate, count });
            remaining -= plate * count;
        }
    }

    const perSideAchieved = perSideTarget - remaining;
    const achievable = barN + 2 * perSideAchieved;
    const diff = round2(targetN - achievable);

    return {
        achievable: round2(achievable),
        perSide: round2(perSideAchieved),
        plates: out,
        diff,
        reachable: diff === 0,
        belowBar: false,
    };
}

function invalid(target, bar) {
    return {
        achievable: 0,
        perSide: 0,
        plates: [],
        diff: Number.isFinite(target) && Number.isFinite(bar) ? Math.abs(target - bar) : 0,
        reachable: false,
        belowBar: false,
        invalid: true,
    };
}

function round2(n) {
    return Math.round(n * 100) / 100;
}

/**
 * Format the plate stack as a compact single-line string for inline UI.
 * Examples:
 *   "Bar + 25, 10"             → "25 + 10"   (per side)
 *   "Bar only"                 → "(bar only)"
 *   target unreachable above   → "25 + 10  (−2.5)"
 */
export function formatPlateStack(result, unit = '') {
    if (!result || result.invalid) return '—';
    if (result.belowBar) return `(below bar)`;

    const parts = [];
    for (const { weight, count } of result.plates) {
        parts.push(count === 1 ? `${weight}${unit}` : `${count}×${weight}${unit}`);
    }
    let line = parts.length === 0 ? '(bar only)' : parts.join(' + ');
    if (!result.reachable && result.diff !== 0) {
        const sign = result.diff > 0 ? '−' : '+';
        line += `  (${sign}${Math.abs(result.diff)}${unit})`;
    }
    return line;
}
