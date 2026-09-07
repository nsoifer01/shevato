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
  if (raw.provider !== undefined) choice(raw.provider, 'provider', ['cms', 'easypost', 'vpic']);
  const id = raw.vertical;
  if (!VERTICALS.some(v => v.id === id) && id !== 'vehicle-data') fail('INVALID_INPUT', 'vertical');
  const i = raw.input;
  let input;
  if (id === 'vehicle-data') { strict(i, ['vin']); input = { vin: vin(i.vin) }; }
  else if (id === 'package-shipping') {
    strict(i, ['originZip', 'destinationZip', 'weight', 'length', 'width', 'height']);
    input = { originZip: zip(i.originZip, 'originZip'), destinationZip: zip(i.destinationZip, 'destinationZip') };
    for (const k of ['weight', 'length', 'width', 'height']) input[k] = number(i[k], k, 0.01, k === 'weight' ? 1120 : 108);
    if (input.length + 2 * (input.width + input.height) > 165) fail('UNSUPPORTED', 'length');
  } else if (id === 'health-insurance') {
    strict(i, ['zip', 'age', 'tobacco', 'year', 'county']);
    input = { zip: zip(i.zip), age: number(i.age, 'age', 18, 64, true), tobacco: choice(i.tobacco, 'tobacco', [true, false]), year: number(i.year, 'year', now.getUTCFullYear(), now.getUTCFullYear() + 1, true) };
    if (i.county !== undefined) input.county = string(i.county, 'county', /^\d{5}$/);
  } else if (['auto-insurance', 'vehicle-warranty', 'vehicle-shipping'].includes(id)) {
    const keys = id === 'auto-insurance' ? ['vin', 'zip', 'coverage'] : id === 'vehicle-warranty' ? ['vin', 'mileage', 'state'] : ['vin', 'originZip', 'destinationZip', 'date', 'transport'];
    strict(i, keys); input = { vin: vin(i.vin) };
    if (id === 'auto-insurance') Object.assign(input, { zip: zip(i.zip), coverage: choice(i.coverage, 'coverage', ['state-minimum', 'basic', 'full', 'custom']) });
    if (id === 'vehicle-warranty') Object.assign(input, { mileage: number(i.mileage, 'mileage', 0, 1000000, true), state: string(i.state, 'state', /^[A-Z]{2}$/) });
    if (id === 'vehicle-shipping') {
      Object.assign(input, { originZip: zip(i.originZip), destinationZip: zip(i.destinationZip), date: string(i.date, 'date', /^\d{4}-\d{2}-\d{2}$/), transport: choice(i.transport, 'transport', ['open', 'enclosed']) });
      if (!Number.isFinite(Date.parse(input.date)) || new Date(input.date).toISOString().slice(0,10) !== input.date || input.date < now.toISOString().slice(0,10)) fail('INVALID_INPUT', 'date');
    }
  } else { strict(i, ['zip']); input = { zip: zip(i.zip) }; }
  return { vertical: id, input, refresh: raw.refresh === true, provider: raw.provider };
}
