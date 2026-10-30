import { faker } from '@faker-js/faker';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
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
    const directory = await tempDirectory('sdlc-logger-');
    return { logFile: path.join(directory, faker.word.noun(), 'run.log') };
  }
});
