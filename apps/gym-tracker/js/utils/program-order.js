/**
 * Shared helper for ordering programs.
 * Used by both the Programs page (where the user picks the sort) and the
 * Dashboard so both views display programs in the same order.
 */

/**
 * Return programs sorted according to `sortMode`.
 *
 * - 'custom'         → respect the user's saved drag-order (`savedOrder`).
 *                      Any program not in `savedOrder` is appended at the end.
 * - 'name-asc'       → A → Z, case-insensitive
 * - 'name-desc'      → Z → A
 * - 'exercises-desc' → most exercises first (name as tiebreaker)
 * - 'exercises-asc'  → fewest exercises first (name as tiebreaker)
 *
 * Pure function — does not mutate inputs.
 */
export function orderPrograms(programs, sortMode = 'custom', savedOrder = []) {
    if (!Array.isArray(programs) || programs.length === 0) return [];

    const cmpName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
    const exCount = (p) => (p.exercises?.length || 0);

    switch (sortMode) {
        case 'name-asc':
            return [...programs].sort(cmpName);
        case 'name-desc':
            return [...programs].sort((a, b) => -cmpName(a, b));
        case 'exercises-desc':
            return [...programs].sort((a, b) => exCount(b) - exCount(a) || cmpName(a, b));
        case 'exercises-asc':
            return [...programs].sort((a, b) => exCount(a) - exCount(b) || cmpName(a, b));
        case 'custom':
        default: {
            const byId = new Map(programs.map(p => [p.id, p]));
            const ordered = [];
            const seen = new Set();
            for (const id of savedOrder || []) {
                const p = byId.get(id);
                if (p && !seen.has(id)) {
                    ordered.push(p);
                    seen.add(id);
                }
            }
            for (const p of programs) {
                if (!seen.has(p.id)) ordered.push(p);
            }
            return ordered;
        }
    }
}
