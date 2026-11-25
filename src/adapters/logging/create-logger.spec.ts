import { faker } from '@faker-js/faker';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { DestinationStream } from 'pino';
import { describe, expect, it } from 'vitest';

import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { ConfigInvalid } from '../../config/errors.js';
import { SandboxUnavailable } from '../../ports/agent-session.js';
import { RunStateInvalid } from '../../ports/run-state-failures.js';
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

describe('logged failures', () => {
  it.each([
    ['a configuration failure', () => new ConfigInvalid({ message: faker.lorem.sentence() })],
    [
      'a failure split out of ConfigInvalid',
      () => new RunStateInvalid({ message: faker.lorem.sentence() }),
    ],
    [
      'a sandbox that did not start',
      () => new SandboxUnavailable({ message: faker.lorem.sentence() }),
    ],
    ['a plain error', () => new Error(faker.lorem.sentence())],
  ])('logs %s under its own identity on the console and in the run log', async (_case, create) => {
    const failure = create();
    const { logged } = await setup({ failure });

    for (const line of logged()) {
      expect(line.err).toMatchObject({ message: failure.message, stack: failure.stack });
      expect(line.err.type).toBe(failure.constructor.name);
      if ('_tag' in failure) expect(line.err._tag).toBe(failure._tag);
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
