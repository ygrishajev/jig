import { faker } from '@faker-js/faker';
import type { Result } from 'better-result';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { everyStepOn } from '../../tests/support/builders.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { MAX_STEP_RETRIES, RETRY_DELAY_MS } from '../domain/settings.js';
import {
  CONFIG_FILE,
  configFileFor,
  configuredSteps,
  type JigConfig,
  loadConfig,
  runSettingsFrom,
  stepsWithoutAgent,
} from './load-config.js';

describe('loadConfig', () => {
  it('merges by hand and picks no agent when the repository has no config', async () => {
    const config = unwrap(loadConfig(await setupFile()));

    expect(config).toMatchObject({
      mergeMode: 'manual',
      designGate: 'auto',
      commitSigning: 'skip',
    });
    expect(stepsWithoutAgent(config)).toEqual(['planner', 'implementer', 'reviewer', 'describer']);
  });

  it('names the steps that still have no agent', async () => {
    const config = unwrap(
      loadConfig(
        await setupFile({ planner: { provider: 'claude' }, reviewer: { provider: 'claude' } }),
      ),
    );

    const steps = configuredSteps(config);

    expect(steps.isErr() && steps.error).toBeInstanceOf(ConfigInvalid);
    expect(steps.isErr() && steps.error.message).toContain('implementer, describer');
  });

  it('gives every step its agent once all of them have one', async () => {
    const step = { provider: 'opencode', model: `openrouter/${faker.word.noun()}` } as const;
    const config = unwrap(loadConfig(await setupFile(everyStepOn(step))));

    expect(unwrap(configuredSteps(config))).toEqual(everyStepOn(step));
  });

  it('takes per-step agents and models from the config file', async () => {
    const model = `openrouter/${faker.word.noun()}`;
    const verifyCommand = `npm run ${faker.word.verb()}`;

    const config = unwrap(
      loadConfig(
        await setupFile({
          implementer: { provider: 'opencode', model },
          verifyCommand,
          commitSigning: 'skip',
        }),
      ),
    );

    expect(config).toMatchObject({
      implementer: { provider: 'opencode', model },
      verifyCommand,
      commitSigning: 'skip',
    });
  });

  it('takes the commands that prepare and check the sandbox', async () => {
    const setupCommand = `npm ${faker.word.verb()}`;

    const config = unwrap(loadConfig(await setupFile({ setupCommand, setupTimeoutSeconds: 120 })));

    expect(config).toMatchObject({ setupCommand, setupTimeoutSeconds: 120 });
  });

  it('reads a preset named by the operator instead of the repository config', async () => {
    const repoRoot = await setup({ mergeMode: 'manual' });
    const preset = `${faker.word.noun()}.json`;
    await writeFile(path.join(repoRoot, preset), JSON.stringify({ mergeMode: 'auto' }));

    expect(unwrap(loadConfig(configFileFor(repoRoot, preset))).mergeMode).toBe('auto');
  });

  it('refuses a named preset that does not exist instead of falling back to defaults', async () => {
    const preset = `${faker.word.noun()}.json`;

    expectInvalid(loadConfig(configFileFor(await setup(), preset)), preset);
  });

  it('rejects a misspelled key instead of ignoring it', async () => {
    const repoRoot = await setup({ implement: { provider: 'claude' } });

    expectInvalid(loadConfig(configFileFor(repoRoot)), 'implement');
  });

  it('rejects an unknown key as invalid config', async () => {
    const repoRoot = await setup({ mergeMod: 'auto' });

    expectInvalid(loadConfig(configFileFor(repoRoot)), 'mergeMod');
  });

  it('reports a config file that is not JSON as invalid config', async () => {
    const repoRoot = await setup();
    await writeFile(path.join(repoRoot, CONFIG_FILE), '{"mergeMode":');

    expectInvalid(loadConfig(configFileFor(repoRoot)), CONFIG_FILE);
  });

  it('rejects an agent it does not know', async () => {
    const repoRoot = await setup({ reviewer: { provider: faker.word.noun() } });

    expectInvalid(loadConfig(configFileFor(repoRoot)), 'reviewer');
  });

  it('takes a version pin for a known agent and rejects one for an agent it does not know', async () => {
    const version = faker.system.semver();

    expect(unwrap(loadConfig(await setupFile({ agents: { opencode: version } }))).agents).toEqual({
      opencode: version,
    });
    const repoRoot = await setup({ agents: { [faker.word.noun()]: version } });
    expectInvalid(loadConfig(configFileFor(repoRoot)), 'agents');
  });

  function expectInvalid(result: Result<JigConfig, ConfigInvalid>, mention: string): void {
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toContain(mention);
  }

  async function setup(contents?: Record<string, unknown>) {
    const repoRoot = await tempDirectory('jig-config-');
    if (contents) await writeFile(path.join(repoRoot, CONFIG_FILE), JSON.stringify(contents));
    return repoRoot;
  }

  async function setupFile(contents?: Record<string, unknown>) {
    return configFileFor(await setup(contents));
  }
});

describe('runSettingsFrom', () => {
  it("takes how a run moves from the config, and the retry policy from jig's own", async () => {
    const reviewCycleCap = faker.number.int({ min: 1, max: 9 });
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const config = {
      ...unwrap(loadConfig(configFileFor(await tempDirectory('jig-config-')))),
      reviewCycleCap,
      verifyCommand,
      designGate: 'checkpoint' as const,
      mergeMode: 'auto' as const,
    };

    expect(runSettingsFrom(config)).toEqual({
      reviewCycleCap,
      verifyCommand,
      designGate: 'checkpoint',
      mergeMode: 'auto',
      maxStepRetries: MAX_STEP_RETRIES,
      retryDelayMs: RETRY_DELAY_MS,
    });
  });
});
