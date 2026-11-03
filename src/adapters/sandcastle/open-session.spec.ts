import { faker } from '@faker-js/faker';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from 'pino';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { runId } from '../../../tests/support/builders.js';
import { RecordingEventSink } from '../../../tests/support/fakes.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { parseEnvironment } from '../../config/environment.js';
import { type JigConfig, loadConfig } from '../../config/load-config.js';
import { orThrow } from '../../domain/errors.js';
import { stateDirectory } from '../local-store/run-paths.js';
import {
  type OpenSessionInput,
  sandcastleSessionOptions,
  warnWhenSandcastleEnvAddsVariables,
} from './open-session.js';

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
    const repoRoot = await tempDirectory('jig-session-');
    const config = { ...orThrow(loadConfig(repoRoot)), ...input.config };
    const environment = orThrow(
      parseEnvironment(input.environment ?? { ANTHROPIC_API_KEY: faker.string.alphanumeric(20) }),
    );
    const options = (overrides: Partial<OpenSessionInput> = {}) =>
      sandcastleSessionOptions(
        { repoRoot, config, environment, imageName: `sandcastle:${faker.word.noun()}` },
        {
          run: { runId: runId(), baseBranch: 'main' },
          events: new RecordingEventSink(),
          ...overrides,
        },
      );
    return { options, repoRoot };
  }
});

describe('warnWhenSandcastleEnvAddsVariables', () => {
  it('names the variables .sandcastle/.env would add to the sandbox', async () => {
    const repoRoot = await tempDirectory('jig-session-');
    const variable = faker.word.noun().toUpperCase();
    await mkdir(path.join(repoRoot, '.sandcastle'), { recursive: true });
    await writeFile(
      path.join(repoRoot, '.sandcastle', '.env'),
      `${variable}=${faker.lorem.word()}\n`,
    );
    const logger = mock<Logger>();

    await warnWhenSandcastleEnvAddsVariables(repoRoot, logger);

    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(variable));
  });

  it('stays quiet when there is no .sandcastle/.env', async () => {
    const logger = mock<Logger>();

    await warnWhenSandcastleEnvAddsVariables(await tempDirectory('jig-session-'), logger);

    expect(logger.warn).not.toHaveBeenCalled();
  });
});
