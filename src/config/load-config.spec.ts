import { faker } from '@faker-js/faker';
import type { Result } from 'better-result';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../tests/support/temp-directory.js';
import { ConfigInvalid, orThrow } from '../domain/errors.js';
import { MAX_STEP_RETRIES, RETRY_DELAY_MS } from '../domain/settings.js';
import { CONFIG_FILE, type JigConfig, loadConfig, runSettingsFrom } from './load-config.js';

describe('loadConfig', () => {
  it('runs every step on claude, merging by hand, when the repository has no config', async () => {
    const config = orThrow(loadConfig(await setup()));

    expect(config).toMatchObject({
      mergeMode: 'manual',
      designGate: 'auto',
      commitSigning: 'repo',
      planner: { provider: 'claude' },
      implementer: { provider: 'claude' },
      reviewer: { provider: 'claude' },
      describer: { provider: 'claude' },
    });
  });

  it('takes per-step agents and models from the config file', async () => {
    const model = `openrouter/${faker.word.noun()}`;
    const verifyCommand = `npm run ${faker.word.verb()}`;

    const config = orThrow(
      loadConfig(
        await setup({
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

    const config = orThrow(loadConfig(await setup({ setupCommand, setupTimeoutSeconds: 120 })));

    expect(config).toMatchObject({ setupCommand, setupTimeoutSeconds: 120 });
  });

  it('rejects a misspelled key instead of ignoring it', async () => {
    const repoRoot = await setup({ implement: { provider: 'claude' } });

    expectInvalid(loadConfig(repoRoot), 'implement');
  });

  it('rejects an unknown key as invalid config', async () => {
    const repoRoot = await setup({ mergeMod: 'auto' });

    expectInvalid(loadConfig(repoRoot), 'mergeMod');
  });

  it('reports a config file that is not JSON as invalid config', async () => {
    const repoRoot = await setup();
    await writeFile(path.join(repoRoot, CONFIG_FILE), '{"mergeMode":');

    expectInvalid(loadConfig(repoRoot), CONFIG_FILE);
  });

  it('rejects an agent it does not know', async () => {
    const repoRoot = await setup({ reviewer: { provider: faker.word.noun() } });

    expectInvalid(loadConfig(repoRoot), 'reviewer');
  });

  it('takes a version pin for a known agent and rejects one for an agent it does not know', async () => {
    const version = faker.system.semver();

    expect(orThrow(loadConfig(await setup({ agents: { opencode: version } }))).agents).toEqual({
      opencode: version,
    });
    const repoRoot = await setup({ agents: { [faker.word.noun()]: version } });
    expectInvalid(loadConfig(repoRoot), 'agents');
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
});

describe('runSettingsFrom', () => {
  it("takes how a run moves from the config, and the retry policy from jig's own", async () => {
    const reviewCycleCap = faker.number.int({ min: 1, max: 9 });
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const config = {
      ...orThrow(loadConfig(await tempDirectory('jig-config-'))),
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
