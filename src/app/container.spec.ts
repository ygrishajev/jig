import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { describe, expect, it } from 'vitest';
import { runId } from '../../tests/support/builders.js';
import { RecordingEventSink } from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import { loadConfig, type SdlcConfig } from '../config/load-config.js';
import {
  createAppContainer,
  sandcastleSessionOptions,
  type OpenSessionInput,
} from './container.js';

describe('sandcastleSessionOptions', () => {
  it("gives each role the agent its step names, with that step's model", async () => {
    const model = `openrouter/${faker.word.noun()}`;
    const { options } = await setup({
      config: { reviewer: { provider: 'opencode', model } },
      environment: {
        CLAUDE_CODE_OAUTH_TOKEN: faker.string.alphanumeric(20),
        OPENROUTER_API_KEY: faker.string.alphanumeric(20),
      },
    });

    const { agents } = options();

    expect(agents.reviewer.name).toBe('opencode');
    expect(agents.implementer.name).toBe('claude-code');
    expect(
      agents.reviewer.buildPrintCommand({ prompt: '', dangerouslySkipPermissions: true }).command,
    ).toContain(model);
  });

  it('passes only the credentials and telemetry variables the sandbox needs', async () => {
    const token = faker.string.alphanumeric(20);
    const endpoint = faker.internet.url();
    const { options } = await setup({
      environment: {
        CLAUDE_CODE_OAUTH_TOKEN: token,
        OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
        [faker.word.noun().toUpperCase()]: faker.lorem.word(),
      },
    });

    expect(options().credentials).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: token,
      OTEL_EXPORTER_OTLP_ENDPOINT: endpoint,
      CLAUDE_CODE_ENABLE_TELEMETRY: '1',
    });
  });

  it('runs the configured setup command unless the caller overrides it or asks for none', async () => {
    const configured = `npm ${faker.word.verb()}`;
    const override = `pnpm ${faker.word.verb()}`;
    const { options } = await setup({ config: { setupCommand: configured } });

    expect(options().setupCommand).toBe(configured);
    expect(options({ setupCommand: override }).setupCommand).toBe(override);
    expect(options({ setupCommand: null }).setupCommand).toBeUndefined();
  });

  it("skips commit signing only when the config says so, and logs agents into the run's state", async () => {
    const skipping = await setup({ config: { commitSigning: 'skip' } });
    const signing = await setup({ config: { commitSigning: 'repo' } });

    const options = skipping.options();

    expect(options.skipCommitSigning).toBe(true);
    expect(signing.options().skipCommitSigning).toBe(false);
    expect(options.agentLogFile.startsWith(stateDirectory(skipping.repoRoot, options.runId))).toBe(
      true,
    );
  });

  async function setup(input: { config?: Partial<SdlcConfig>; environment?: NodeJS.ProcessEnv }) {
    const repoRoot = await tempDirectory('sdlc-container-');
    const config = { ...loadConfig(repoRoot), ...input.config };
    const environment = input.environment ?? { ANTHROPIC_API_KEY: faker.string.alphanumeric(20) };
    const options = (overrides: Partial<OpenSessionInput> = {}) =>
      sandcastleSessionOptions(
        repoRoot,
        config,
        {
          run: { runId: runId(), baseBranch: 'main' },
          events: new RecordingEventSink(),
          ...overrides,
        },
        environment,
      );
    return { options, repoRoot };
  }
});

describe('createAppContainer', () => {
  it('derives the run settings from the config', async () => {
    const repoRoot = await tempDirectory('sdlc-container-');
    const app = createAppContainer({ repoRoot, logFormat: 'json', logLevel: 'silent' });
    const reviewCycleCap = faker.number.int({ min: 1, max: 9 });
    const verifyCommand = `npm run ${faker.word.verb()}`;
    app.register({
      config: asValue({
        ...loadConfig(repoRoot),
        reviewCycleCap,
        verifyCommand,
        designGate: 'checkpoint',
        mergeMode: 'auto',
      }),
    });

    expect(app.cradle.settings).toMatchObject({
      reviewCycleCap,
      verifyCommand,
      designGate: 'checkpoint',
      mergeMode: 'auto',
    });
    await app.dispose();
  });
});
