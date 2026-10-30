import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    testTimeout: 20000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
