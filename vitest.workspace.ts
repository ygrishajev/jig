import { defineProject, defineWorkspace } from 'vitest/config';

export const unitProject = defineProject({
  test: {
    name: 'unit',
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    testTimeout: 20_000,
  },
});

export default defineWorkspace([
  unitProject,
  {
    test: {
      name: 'e2e',
      include: ['tests/e2e/**/*.spec.ts'],
      testTimeout: 32 * 60 * 1000,
      hookTimeout: 30_000,
      retry: 0,
    },
  },
]);
