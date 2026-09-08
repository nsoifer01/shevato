import { VERTICALS } from '../../../../apps/quotescout/js/model.js';
export class ScoutError extends Error {
  constructor(code, field = '') { super(code); this.code = code; this.field = field; }
}
export const fail = (code, field) => { throw new ScoutError(code, field); };
const object = v => v && typeof v === 'object' && !Array.isArray(v);
export function strict(v, keys) { if (!object(v) || Object.keys(v).some(k => !keys.includes(k))) fail('INVALID_INPUT'); }
export function string(v, field, pattern, max = 120) { if (typeof v !== 'string' || v.length > max || !pattern.test(v.trim())) fail('INVALID_INPUT', field); return v.trim(); }
export const zip = (v, field = 'zip') => string(v, field, /^\d{5}$/);
export function number(v, field, min, max, integer = false) { if (typeof v !== 'number' || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) fail('INVALID_INPUT', field); return v; }
export function vin(v) {
  const value = string(v, 'vin', /^[A-HJ-NPR-Za-hj-npr-z0-9]{17}$/, 30).toUpperCase();
  // North American VINs require the check digit; other regions are validated by vPIC.
  if (/^[1-5]/.test(value)) {
    const letters = 'ABCDEFGHJKLMNPRSTUVWXYZ', values = '12345678123457923456789';
    const weights = [8,7,6,5,4,3,2,10,0,9,8,7,6,5,4,3,2];
    const sum = [...value].reduce((n, c, i) => n + (/\d/.test(c) ? +c : +values[letters.indexOf(c)]) * weights[i], 0) % 11;
    if (value[8] !== (sum === 10 ? 'X' : String(sum))) fail('INVALID_INPUT', 'vin');
  }
  return value;
}
const choice = (v, field, options) => options.includes(v) ? v : fail('INVALID_INPUT', field);
export function validateRequest(raw, now = new Date()) {
  strict(raw, ['vertical', 'input', 'refresh', 'provider']);
  if (raw.refresh !== undefined && typeof raw.refresh !== 'boolean') fail('INVALID_INPUT');
  if (raw.provider !== undefined) choice(raw.provider, 'provider', ['cms-puf', 'cms-puf-dental', 'medicare-advantage', 'medicare-drug', 'vpic']);
  const id = raw.vertical;
  if (!VERTICALS.some(v => v.id === id) && id !== 'vehicle-data') fail('INVALID_INPUT', 'vertical');
  const i = raw.input;
  let input;
  if (id === 'vehicle-data') { strict(i, ['vin']); input = { vin: vin(i.vin) }; }
  else if (id === 'health-insurance' || id === 'dental-insurance') {
    strict(i, ['zip', 'age', 'tobacco', 'year', 'county']);
    input = { zip: zip(i.zip), age: number(i.age, 'age', 18, 64, true), tobacco: choice(i.tobacco, 'tobacco', [true, false]), year: number(i.year, 'year', now.getUTCFullYear(), now.getUTCFullYear() + 1, true) };
    if (i.county !== undefined) input.county = string(i.county, 'county', /^\d{5}$/);
  } else {
    // Medicare premiums do not vary with age, sex or tobacco, so a ZIP is the
    // whole of the required input; county only appears when a ZIP straddles two.
    strict(i, ['zip', 'county']);
    input = { zip: zip(i.zip) };
    if (i.county !== undefined) input.county = string(i.county, 'county', /^\d{5}$/);
  }
  return { vertical: id, input, refresh: raw.refresh === true, provider: raw.provider };
}
