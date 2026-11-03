import { faker } from '@faker-js/faker';
import { asValue } from 'awilix';
import { describe, expect, it, onTestFinished } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import {
  FakeAgentSession,
  InMemoryRunStore,
  RecordingEventSink,
} from '../../tests/support/fakes.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { stateDirectory } from '../adapters/local-store/run-paths.js';
import { parseEnvironment } from '../config/environment.js';
import { type JigConfig, loadConfig } from '../config/load-config.js';
import {
  createAppContainer,
  type OpenSessionInput,
  sandcastleSessionOptions,
  withRunScope,
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

  async function setup(input: { config?: Partial<JigConfig>; environment?: NodeJS.ProcessEnv }) {
    const repoRoot = await tempDirectory('jig-container-');
    const config = { ...loadConfig(repoRoot), ...input.config };
    const environment = parseEnvironment(
      input.environment ?? { ANTHROPIC_API_KEY: faker.string.alphanumeric(20) },
    );
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

describe('withRunScope', () => {
  it("hands the work the run's sandbox and closes it once the work is done", async () => {
    const { app, session, run } = await setup();

    const used = await withRunScope(
      app,
      run,
      new InMemoryRunStore(),
      {},
      async (dependencies) => dependencies.ports.agent,
    );

    expect(used).toBe(session);
    expect(session.closed).toBe(true);
  });

  it('closes the sandbox when the work inside it fails', async () => {
    const { app, session, run } = await setup();
    const failure = new Error(faker.lorem.sentence());

    await expect(
      withRunScope(app, run, new InMemoryRunStore(), {}, async () => {
        throw failure;
      }),
    ).rejects.toBe(failure);
    expect(session.closed).toBe(true);
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-run-scope-');
    const session = new FakeAgentSession(repoRoot);
    const app = createAppContainer({
      repoRoot,
      logFormat: 'json',
      logLevel: 'silent',
      environment: parseEnvironment({}),
    });
    app.register({ openSession: asValue(async () => session) });
    onTestFinished(() => app.dispose());
    return { app, session, run: { runId: runId(), baseBranch: faker.git.branch() } };
  }
});
