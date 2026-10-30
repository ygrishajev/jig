import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    workspace: 'vitest.unit.workspace.ts',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.spec.ts'],
      reporter: ['text', 'html', 'lcov'],
    },
  },
});
