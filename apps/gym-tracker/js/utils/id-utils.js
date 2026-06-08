/**
 * Shared id-comparison helper.
 *
 * Program (and session) ids are generated numerically (Program.js uses
 * generateNumericId()), but ids that arrive from the DOM — `dataset.*`
 * attributes, drag payloads, URL state — are always strings. Imported or
 * legacy data may also carry string ids. Comparing the two with `===`
 * silently fails (1 !== "1"). `sameId` normalizes both sides to strings so
 * numeric and string ids match regardless of where they came from.
 */
export function sameId(a, b) {
    return String(a) === String(b);
}
