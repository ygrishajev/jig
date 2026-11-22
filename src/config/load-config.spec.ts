import { faker } from '@faker-js/faker';
import type { Result } from 'better-result';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { everyStepOn } from '../../tests/support/builders.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { ConfigInvalid } from '../domain/errors.js';
import { MAX_STEP_RETRIES, RETRY_DELAY_MS } from '../domain/settings.js';
import { DEFAULT_CLAUDE_MODEL } from './agent-policy.js';
import {
  CONFIG_FILE,
  configFileFor,
  configFrom,
  configuredSteps,
  type JigConfig,
  mayBeAbsent,
  runSettingsFrom,
  type StepConfig,
  stepsWithoutAgent,
  validationWarnings,
} from './load-config.js';

describe('configFrom', () => {
  it('merges by hand and picks no agent when the file sets nothing', () => {
    const config = unwrap(configFrom(aConfigFile(), {}));

    expect(config).toMatchObject({
      mergeMode: 'manual',
      designGate: 'auto',
      commitSigning: 'skip',
    });
    expect(stepsWithoutAgent(config)).toEqual(['planner', 'implementer', 'reviewer', 'describer']);
  });

  it('names the steps that still have no agent', () => {
    const config = unwrap(
      configFrom(aConfigFile(), {
        planner: { provider: 'claude' },
        reviewer: { provider: 'claude' },
      }),
    );

    const steps = configuredSteps(config);

    expect(steps.isErr() && steps.error).toBeInstanceOf(ConfigInvalid);
    expect(steps.isErr() && steps.error.message).toContain('implementer, describer');
  });

  it('gives every step its agent once all of them have one', () => {
    const step = { provider: 'opencode', model: `openrouter/${faker.word.noun()}` } as const;
    const config = unwrap(configFrom(aConfigFile(), everyStepOn(step)));

    expect(unwrap(configuredSteps(config))).toEqual(everyStepOn(step));
  });

  it('takes per-step agents and models from the config file', () => {
    const model = `openrouter/${faker.word.noun()}`;
    const verifyCommand = `npm run ${faker.word.verb()}`;

    const config = unwrap(
      configFrom(aConfigFile(), {
        implementer: { provider: 'opencode', model },
        verifyCommand,
        commitSigning: 'skip',
      }),
    );

    expect(config).toMatchObject({
      implementer: { provider: 'opencode', model },
      verifyCommand,
      commitSigning: 'skip',
    });
  });

  it('takes the commands that prepare and check the sandbox', () => {
    const setupCommand = `npm ${faker.word.verb()}`;

    const config = unwrap(configFrom(aConfigFile(), { setupCommand, setupTimeoutSeconds: 120 }));

    expect(config).toMatchObject({ setupCommand, setupTimeoutSeconds: 120 });
  });

  it('rejects a misspelled key instead of ignoring it, naming the file', () => {
    const file = aConfigFile();

    const result = configFrom(file, { implement: { provider: 'claude' } });

    expectInvalid(result, 'implement');
    expectInvalid(result, file.name);
  });

  it('rejects an unknown key as invalid config', () => {
    expectInvalid(configFrom(aConfigFile(), { mergeMod: 'auto' }), 'mergeMod');
  });

  it('rejects a file that does not hold an object', () => {
    const file = aConfigFile();

    expectInvalid(configFrom(file, [faker.word.noun()]), file.name);
  });

  it('rejects an agent it does not know', () => {
    expectInvalid(
      configFrom(aConfigFile(), { reviewer: { provider: faker.word.noun() } }),
      'reviewer',
    );
  });

  it('takes a version pin for a known agent and rejects one for an agent it does not know', () => {
    const version = faker.system.semver();

    expect(unwrap(configFrom(aConfigFile(), { agents: { opencode: version } })).agents).toEqual({
      opencode: version,
    });
    expectInvalid(
      configFrom(aConfigFile(), { agents: { [faker.word.noun()]: version } }),
      'agents',
    );
  });

  function expectInvalid(result: Result<JigConfig, ConfigInvalid>, mention: string): void {
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toContain(mention);
  }
});

describe('configFileFor', () => {
  it("selects the repository's own config, which may be absent", () => {
    const repoRoot = faker.system.directoryPath();

    const file = configFileFor(repoRoot);

    expect(file).toEqual({
      path: path.join(repoRoot, CONFIG_FILE),
      name: CONFIG_FILE,
      named: false,
    });
    expect(mayBeAbsent(file)).toBe(true);
  });

  it('selects a preset named by the operator against the repository root, which must exist', () => {
    const repoRoot = faker.system.directoryPath();
    const preset = `${faker.word.noun()}.json`;

    const file = configFileFor(repoRoot, preset);

    expect(file).toEqual({ path: path.join(repoRoot, preset), name: preset, named: true });
    expect(mayBeAbsent(file)).toBe(false);
  });
});

describe('runSettingsFrom', () => {
  it("takes how a run moves from the config, and the retry policy from jig's own", () => {
    const reviewCycleCap = faker.number.int({ min: 1, max: 9 });
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const config = {
      ...unwrap(configFrom(aConfigFile(), {})),
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
  it('warns about nothing when the reviewer differs and a verifyCommand is set', () => {
    const config = setup({
      implementer: { provider: 'claude', model: 'sonnet' },
      reviewer: { provider: 'claude', model: 'opus' },
      verifyCommand: aVerifyCommand(),
    });

    expect(validationWarnings(config)).toEqual([]);
  });

  it('warns once for the defaults, which pick no agent and set no verifyCommand', () => {
    expect(validationWarnings(setup({}))).toHaveLength(1);
  });

  it('names the provider and model when the reviewer runs the same model as the implementer', () => {
    const step = { provider: 'opencode', model: `openrouter/${faker.word.noun()}` } as const;
    const config = setup({
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
    (mergeMode) => {
      const config = setup({ mergeMode });

      expect(validationWarnings(config)).toHaveLength(1);
      expect(validationWarnings({ ...config, verifyCommand: aVerifyCommand() })).toEqual([]);
    },
  );

  it('names the shared model before the missing verifyCommand when both apply', () => {
    const step = { provider: 'codex', model: faker.word.noun() } as const;
    const config = setup({ implementer: step, reviewer: step });
    const unverifiedOnlyWarnings = validationWarnings(setup({}));

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
  ])('decides whether $case is a shared reviewer model', ({ implementer, reviewer, shared }) => {
    const config = setup({ implementer, reviewer, verifyCommand: aVerifyCommand() });

    expect(validationWarnings(config)).toHaveLength(shared ? 1 : 0);
  });

  it('names claude with its default model when neither step names one', () => {
    const step = { provider: 'claude' } as const;
    const config = setup({
      implementer: step,
      reviewer: step,
      verifyCommand: aVerifyCommand(),
    });

    expect(validationWarnings(config)[0]).toContain(`claude/${DEFAULT_CLAUDE_MODEL}`);
  });

  it.each(['implementer', 'reviewer'] as const)(
    'compares no models while the %s has no agent',
    (configured) => {
      const config = setup({
        [configured]: { provider: 'claude' },
        verifyCommand: aVerifyCommand(),
      });

      expect(validationWarnings(config)).toEqual([]);
    },
  );

  function setup(contents: Record<string, unknown>) {
    return unwrap(configFrom(aConfigFile(), contents));
  }
});

function aConfigFile() {
  return configFileFor(faker.system.directoryPath());
}

function aVerifyCommand() {
  return `npm run ${faker.word.verb()}`;
}
