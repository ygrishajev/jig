import { faker } from '@faker-js/faker';
import { TaggedError } from 'better-result';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DestinationStream } from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { runId } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { observedEvents } from '../../app/observed-events.js';
import { RunStoreSetupInvalid } from '../../app/run-stores.js';
import { ConfigInvalid } from '../../config/errors.js';
import type { RunEvent } from '../../domain/events.js';
import {
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
  SandboxUnavailable,
} from '../../ports/agent-session.js';
import { RepositoryInvalid } from '../../ports/git-failures.js';
import { LocalPreparationFailed } from '../../ports/local-state.js';
import { RunStateInvalid } from '../../ports/run-state-failures.js';
import { RunStoreOperationFailed } from '../../ports/run-store.js';
import { createConsoleLogger, createRunLogger, defaultLogFormat } from './create-logger.js';

describe('defaultLogFormat', () => {
  it('logs pretty to a terminal and JSON lines anywhere else', () => {
    expect(defaultLogFormat({ isTTY: true })).toBe('pretty');
    expect(defaultLogFormat({ isTTY: false })).toBe('json');
    expect(defaultLogFormat({})).toBe('json');
  });
});

describe('createConsoleLogger', () => {
  it('logs at the level it is given, info by default', () => {
    expect(createConsoleLogger('json').level).toBe('info');
    expect(createConsoleLogger('pretty', 'warn').level).toBe('warn');
  });
});

describe('createRunLogger', () => {
  it("writes JSON lines at or above its level into the run's log file, creating its directory", async () => {
    const { logFile } = await setup();
    const kept = faker.lorem.sentence();
    const logger = createRunLogger('pretty', logFile, 'error');

    logger.warn(faker.lorem.sentence());
    logger.error({ runId: faker.string.alphanumeric(8) }, kept);
    logger.flush();

    const lines = readFileSync(logFile, 'utf-8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ level: 50, msg: kept });
  });

  async function setup() {
    const directory = await tempDirectory('jig-logger-');
    return { logFile: path.join(directory, faker.word.noun(), 'run.log') };
  }
});

/** Another module's failure that happens to carry a split class's tag under its own name. */
class ForeignFailure extends TaggedError('RunStateInvalid')<{ message: string }> {}

describe('logged failures', () => {
  const splitFromConfigInvalid = [
    RunStateInvalid,
    RunStoreOperationFailed,
    RunStoreSetupInvalid,
    SandboxCredentialsInvalid,
    SandboxPreparationInvalid,
    RepositoryInvalid,
    LocalPreparationFailed,
  ];

  it.each(splitFromConfigInvalid.map((Failure) => [Failure.name, Failure] as const))(
    'logs %s under ConfigInvalid on the console and in the run log',
    async (_name, Failure) => {
      const failure = new Failure({ message: faker.lorem.sentence() });
      const { logged } = await setup({ failure });

      for (const line of logged()) {
        expect(line.err).toMatchObject({
          type: 'ConfigInvalid',
          _tag: 'ConfigInvalid',
          name: 'ConfigInvalid',
          kind: 'fatal',
          message: failure.message,
          stack: `ConfigInvalid${failure.stack?.slice(Failure.name.length)}`,
        });
      }
      expect(logged()).toHaveLength(3);
      expect(failure._tag).toBe(Failure.name);
      expect(failure.name).toBe(Failure.name);
    },
  );

  it.each([
    ['a configuration failure', () => new ConfigInvalid({ message: faker.lorem.sentence() })],
    [
      'a sandbox that did not start',
      () => new SandboxUnavailable({ message: faker.lorem.sentence() }),
    ],
    ['a plain error', () => new Error(faker.lorem.sentence())],
    [
      'a foreign failure sharing a split name only as its tag',
      () => new ForeignFailure({ message: faker.lorem.sentence() }),
    ],
  ])('logs %s under its own identity', async (_case, create) => {
    const failure = create();
    const { logged } = await setup({ failure });

    for (const line of logged()) {
      expect(line.err).toMatchObject({ message: failure.message, stack: failure.stack });
      expect(line.err.type).toBe(failure.constructor.name);
    }
    expect(logged()).toHaveLength(3);
  });

  it.each([
    ['null', () => null],
    ['a string', () => faker.lorem.sentence()],
    ['a number', () => faker.number.int()],
    ['an object without a message', () => ({ code: faker.string.alphanumeric(8) })],
  ])('logs %s thrown in place of an error as it is', async (_case, create) => {
    const failure = create();
    const { logged } = await setup({ failure });

    for (const line of logged()) {
      expect(line.err).toEqual(failure);
    }
    expect(logged()).toHaveLength(3);
  });

  it('logs an observer that throws null and still hands the event to the other observers', async () => {
    const { logged, runLogger } = await setup({});
    const event: RunEvent = {
      type: 'agentMessage',
      runId: runId(),
      role: faker.helpers.arrayElement(['planner', 'implementer', 'reviewer'] as const),
      text: faker.lorem.sentence(),
    };
    const second = vi.fn<(event: RunEvent) => void>();
    const events = observedEvents(runLogger, [
      {
        handle: () => {
          throw null;
        },
      },
      { handle: second },
    ]);

    events.publish(event);
    runLogger.flush();

    expect(second).toHaveBeenCalledWith(event);
    expect(logged().filter((line) => 'err' in line)).toEqual([
      expect.objectContaining({ err: null }),
      expect.objectContaining({ err: null }),
    ]);
  });

  async function setup(input: { failure?: unknown }) {
    const directory = await tempDirectory('jig-logger-failure-');
    const logFile = path.join(directory, 'run.log');
    const consoleLines: string[] = [];
    const consoleDestination: DestinationStream = {
      write: (line) => void consoleLines.push(line),
    };
    const message = faker.lorem.sentence();
    const runLogger = createRunLogger('json', logFile, 'info', consoleDestination);
    if ('failure' in input) {
      createConsoleLogger('json', 'info', consoleDestination).error(
        { err: input.failure },
        message,
      );
      runLogger.error({ err: input.failure }, message);
      runLogger.flush();
    }
    const parse = (line: string): { err: Record<string, unknown> } => JSON.parse(line);
    return {
      runLogger,
      logged: () => [
        ...consoleLines.map(parse),
        ...readFileSync(logFile, 'utf-8').trim().split('\n').map(parse),
      ],
    };
  }
});
