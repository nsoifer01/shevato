/**
 * Vitest global setup
 * Provides jsdom environment and common test utilities
 */

import { afterEach } from 'vitest';

// Clear localStorage between tests
afterEach(() => {
  localStorage.clear();
});
