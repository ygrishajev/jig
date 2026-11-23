import { faker } from '@faker-js/faker';
import type { Result } from 'better-result';
import { describe, expect, it } from 'vitest';

import { everyStepOn } from '../../tests/support/builders.js';
import { InMemoryConfigSource } from '../../tests/support/fakes.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { DEFAULT_CLAUDE_MODEL } from './agent-policy.js';
import { ConfigInvalid } from './errors.js';
import {
  configuredSteps,
  type JigConfig,
  loadConfig,
  runSettingsFrom,
  type StepConfig,
  stepsWithoutAgent,
  validationWarnings,
} from './load-config.js';

describe('loadConfig', () => {
  it('merges by hand and picks no agent when the file sets nothing', () => {
    const config = unwrap(loadSettings({}));

    expect(config).toMatchObject({
      mergeMode: 'manual',
      designGate: 'auto',
      commitSigning: 'skip',
    });
    expect(stepsWithoutAgent(config)).toEqual(['planner', 'implementer', 'reviewer', 'describer']);
  });

  it('names the steps that still have no agent', () => {
    const config = unwrap(
      loadSettings({
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
    const config = unwrap(loadSettings(everyStepOn(step)));

    expect(unwrap(configuredSteps(config))).toEqual(everyStepOn(step));
  });

  it('takes per-step agents and models from the config file', () => {
    const model = `openrouter/${faker.word.noun()}`;
    const verifyCommand = `npm run ${faker.word.verb()}`;

    const config = unwrap(
      loadSettings({
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

    const config = unwrap(loadSettings({ setupCommand, setupTimeoutSeconds: 120 }));

    expect(config).toMatchObject({ setupCommand, setupTimeoutSeconds: 120 });
  });

  it('rejects a misspelled key instead of ignoring it, naming the file', () => {
    const source = new InMemoryConfigSource({ json: { implement: { provider: 'claude' } } });

    const result = loadConfig(source);

    expectInvalid(result, 'implement');
    expectInvalid(result, `${source.name} is not valid — `);
  });

  it('rejects an unknown key as invalid config', () => {
    expectInvalid(loadSettings({ mergeMod: 'auto' }), 'mergeMod');
  });

  it.each([
    ['maxStepRetries', faker.number.int({ min: 0, max: 9 })],
    ['retryDelayMs', faker.number.int({ min: 0, max: 9999 })],
  ])('refuses %s, which the retry defaults do not let a project override', (key, value) => {
    expectInvalid(loadSettings({ [key]: value }), key);
  });

  it('rejects a file that does not hold an object', () => {
    const source = new InMemoryConfigSource({ json: [faker.word.noun()] });

    expectInvalid(loadConfig(source), source.name);
  });

  it('rejects an agent it does not know', () => {
    expectInvalid(loadSettings({ reviewer: { provider: faker.word.noun() } }), 'reviewer');
  });

  it('takes a version pin for a known agent and rejects one for an agent it does not know', () => {
    const version = faker.system.semver();

    expect(unwrap(loadSettings({ agents: { opencode: version } })).agents).toEqual({
      opencode: version,
    });
    expectInvalid(loadSettings({ agents: { [faker.word.noun()]: version } }), 'agents');
  });

  function expectInvalid(result: Result<JigConfig, ConfigInvalid>, mention: string): void {
    expect(result.isErr()).toBe(true);
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toContain(mention);
  }
});

describe('loadConfig from its source', () => {
  it("gives every default when the repository's own settings are absent", () => {
    const source = new InMemoryConfigSource({ custom: false });

    expect(unwrap(loadConfig(source))).toEqual(unwrap(loadSettings({})));
  });

  it('refuses absent settings the operator chose, with why nothing was found', () => {
    const source = new InMemoryConfigSource({ custom: true });

    expectExactly(loadConfig(source), `Cannot read ${source.name}: ${source.detail}`);
  });

  it('refuses settings it cannot read, with why', () => {
    const source = new InMemoryConfigSource({ failure: 'unreadable' });

    expectExactly(loadConfig(source), `Cannot read ${source.name}: ${source.detail}`);
  });

  it('refuses settings that are not JSON, with why', () => {
    const source = new InMemoryConfigSource({ failure: 'not-json' });

    expectExactly(loadConfig(source), `${source.name} is not valid JSON: ${source.detail}`);
  });

  function expectExactly(result: Result<JigConfig, ConfigInvalid>, message: string): void {
    expect(result.isErr() && result.error).toBeInstanceOf(ConfigInvalid);
    expect(result.isErr() && result.error.message).toBe(message);
  }
});

describe('runSettingsFrom', () => {
  it('takes how a run moves from the config, and retries a failed step twice from 5000 ms', () => {
    const reviewCycleCap = faker.number.int({ min: 1, max: 9 });
    const verifyCommand = `npm run ${faker.word.verb()}`;
    const config = {
      ...unwrap(loadSettings({})),
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
      maxStepRetries: 2,
      retryDelayMs: 5000,
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
    return unwrap(loadSettings(contents));
  }
});

function loadSettings(json: unknown) {
  return loadConfig(new InMemoryConfigSource({ json }));
}

function aVerifyCommand() {
  return `npm run ${faker.word.verb()}`;
}
