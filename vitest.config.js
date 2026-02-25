import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    setupFiles: ['./tests/setup.js'],
    include: ['tests/**/*.test.js'],
    coverage: {
      include: [
        'shared/utils/**',
        'apps/gym-tracker/js/models/**',
        'apps/gym-tracker/js/services/**',
        'apps/gym-tracker/js/utils/**',
      ],
    },
  },
});
