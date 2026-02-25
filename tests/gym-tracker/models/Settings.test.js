import { describe, it, expect } from 'vitest';
import { Settings } from '../../../apps/gym-tracker/js/models/Settings.js';

describe('Settings', () => {
  it('creates with defaults', () => {
    const s = new Settings();
    expect(s.weightUnit).toBe('kg');
    expect(s.theme).toBe('dark');
    expect(s.dateFormat).toBe('MM/DD/YYYY');
    expect(s.firstDayOfWeek).toBe(0);
  });

  it('creates from data', () => {
    const s = new Settings({ weightUnit: 'lb', theme: 'light', firstDayOfWeek: 1 });
    expect(s.weightUnit).toBe('lb');
    expect(s.theme).toBe('light');
    expect(s.firstDayOfWeek).toBe(1);
  });

  it('getDefault returns default settings', () => {
    const s = Settings.getDefault();
    expect(s.weightUnit).toBe('kg');
    expect(s.theme).toBe('dark');
  });

  describe('serialization', () => {
    it('round-trips through JSON', () => {
      const s = new Settings({ weightUnit: 'lb', theme: 'light' });
      const restored = Settings.fromJSON(s.toJSON());
      expect(restored.weightUnit).toBe('lb');
      expect(restored.theme).toBe('light');
    });
  });
});
