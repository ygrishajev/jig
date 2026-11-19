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
import { DEFAULT_CLAUDE_MODEL } from './agent-policy.js';
import {
  CONFIG_FILE,
  configFileFor,
  configuredSteps,
  type JigConfig,
  loadConfig,
  runSettingsFrom,
  type StepConfig,
  stepsWithoutAgent,
  validationWarnings,
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

describe('validationWarnings', () => {
  it('warns about nothing when the reviewer differs and a verifyCommand is set', async () => {
    const config = await setup({
      implementer: { provider: 'claude', model: 'sonnet' },
      reviewer: { provider: 'claude', model: 'opus' },
      verifyCommand: aVerifyCommand(),
    });

    expect(validationWarnings(config)).toEqual([]);
  });

  it('warns once for the defaults, which pick no agent and set no verifyCommand', async () => {
    expect(validationWarnings(await setup({}))).toHaveLength(1);
  });

  it('names the provider and model when the reviewer runs the same model as the implementer', async () => {
    const step = { provider: 'opencode', model: `openrouter/${faker.word.noun()}` } as const;
    const config = await setup({
      implementer: step,
      reviewer: step,
      verifyCommand: aVerifyCommand(),
    });

    const warnings = validationWarnings(config);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain(`${step.provider}/${step.model}`);
  });

  it.each(['manual', 'auto'] as const)(
    'warns once when no verifyCommand is set and mergeMode is %s',
    async (mergeMode) => {
      const config = await setup({ mergeMode });

      expect(validationWarnings(config)).toHaveLength(1);
      expect(validationWarnings({ ...config, verifyCommand: aVerifyCommand() })).toEqual([]);
    },
  );

  it('names the shared model before the missing verifyCommand when both apply', async () => {
    const step = { provider: 'codex', model: faker.word.noun() } as const;
    const config = await setup({ implementer: step, reviewer: step });
    const unverifiedOnlyWarnings = validationWarnings(await setup({}));

    const warnings = validationWarnings(config);

    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(`${step.provider}/${step.model}`);
    expect(warnings.slice(1)).toEqual(unverifiedOnlyWarnings);
  });

  it.each<{ case: string; implementer: StepConfig; reviewer: StepConfig; shared: boolean }>([
    {
      case: "claude's default model and the same model named",
      implementer: { provider: 'claude' },
      reviewer: { provider: 'claude', model: DEFAULT_CLAUDE_MODEL },
      shared: true,
    },
    {
      case: "claude's default model on both",
      implementer: { provider: 'claude' },
      reviewer: { provider: 'claude' },
      shared: true,
    },
    {
      case: "claude's default model and another claude model",
      implementer: { provider: 'claude' },
      reviewer: { provider: 'claude', model: 'haiku' },
      shared: false,
    },
    {
      case: 'the same model name on different agents',
      implementer: { provider: 'codex', model: 'gpt-6-luna' },
      reviewer: { provider: 'opencode', model: 'gpt-6-luna' },
      shared: false,
    },
    {
      case: 'an agent with no default model and no model named',
      implementer: { provider: 'opencode' },
      reviewer: { provider: 'opencode' },
      shared: false,
    },
    {
      case: 'an agent with no default model and a model named on one side only',
      implementer: { provider: 'codex' },
      reviewer: { provider: 'codex', model: 'gpt-6-luna' },
      shared: false,
    },
  ])(
    'decides whether $case is a shared reviewer model',
    async ({ implementer, reviewer, shared }) => {
      const config = await setup({ implementer, reviewer, verifyCommand: aVerifyCommand() });

      expect(validationWarnings(config)).toHaveLength(shared ? 1 : 0);
    },
  );

  it('names claude with its default model when neither step names one', async () => {
    const step = { provider: 'claude' } as const;
    const config = await setup({
      implementer: step,
      reviewer: step,
      verifyCommand: aVerifyCommand(),
    });

    expect(validationWarnings(config)[0]).toContain(`claude/${DEFAULT_CLAUDE_MODEL}`);
  });

  it.each(['implementer', 'reviewer'] as const)(
    'compares no models while the %s has no agent',
    async (configured) => {
      const config = await setup({
        [configured]: { provider: 'claude' },
        verifyCommand: aVerifyCommand(),
      });

      expect(validationWarnings(config)).toEqual([]);
    },
  );

  async function setup(contents: Record<string, unknown>) {
    const repoRoot = await tempDirectory('jig-config-');
    await writeFile(path.join(repoRoot, CONFIG_FILE), JSON.stringify(contents));
    return unwrap(loadConfig(configFileFor(repoRoot)));
  }
});

function aVerifyCommand() {
  return `npm run ${faker.word.verb()}`;
}
