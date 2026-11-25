import { configDefaults, defineProject, defineWorkspace } from 'vitest/config';

const integrationSpecs = ['src/**/*.integration.spec.ts', 'scripts/**/*.integration.spec.ts'];

export const unitProject = defineProject({
  test: {
    name: 'unit',
    include: ['src/**/*.spec.ts', 'scripts/**/*.spec.ts'],
    exclude: [...configDefaults.exclude, ...integrationSpecs],
    testTimeout: 5_000,
    unstubEnvs: true,
  },
});

export const integrationProject = defineProject({
  test: {
    name: 'integration',
    include: integrationSpecs,
    testTimeout: 60_000,
    unstubEnvs: true,
    /**
     * Temp repositories must not pick up the developer's git config: hooks, signing, templates.
     * Nor may git's automatic maintenance detach from a command and keep writing to a temp
     * repository after the test that made it has removed it.
     */
    env: {
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_COUNT: '1',
      GIT_CONFIG_KEY_0: 'maintenance.auto',
      GIT_CONFIG_VALUE_0: 'false',
    },
  },
});

export default defineWorkspace([
  unitProject,
  integrationProject,
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
