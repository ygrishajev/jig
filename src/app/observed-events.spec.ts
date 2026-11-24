import { faker } from '@faker-js/faker';
import { isPanic, panic } from 'better-result';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { runId } from '../../tests/support/builders.js';
import { tempDirectory } from '../../tests/support/temp-directory.js';
import { createRunLogger } from '../adapters/logging/create-logger.js';
import type { RunEvent } from '../domain/events.js';
import { observedEvents } from './observed-events.js';

describe('observedEvents', () => {
  it('hands every event to every observer', () => {
    const { logger, events, event, first, second } = setup();

    events.publish(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs an observer that fails and hands the event to the others', () => {
    const failure = new Error(faker.lorem.sentence());
    const { logger, events, event, second } = setup({ failing: () => failure });

    events.publish(event);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [record] = logger.warn.mock.calls[0];
    expect((record as { err: unknown }).err).toBe(failure);
    expect(second).toHaveBeenCalledWith(event);
  });

  it("writes an observer that throws null to the run's log and still hands the event to the others", async () => {
    const directory = await tempDirectory('jig-observed-events-');
    const logFile = path.join(directory, 'run.log');
    const consoleLines: string[] = [];
    const runLogger = createRunLogger('json', logFile, 'info', {
      write: (line) => void consoleLines.push(line),
    });
    const { events, event, second } = setup({ logger: runLogger, failing: () => null });

    events.publish(event);
    runLogger.flush();

    const logged = [...consoleLines, ...readFileSync(logFile, 'utf-8').trim().split('\n')].map(
      (line): Record<string, unknown> => JSON.parse(line),
    );
    expect(second).toHaveBeenCalledWith(event);
    expect(logged.filter((line) => 'err' in line)).toEqual([
      expect.objectContaining({ err: null }),
      expect.objectContaining({ err: null }),
    ]);
  });

  it('lets a panic in an observer through without logging it as an observer failure', () => {
    const { logger, events, event } = setup({
      failing: () => panic(faker.lorem.sentence()),
    });

    const thrown = captured(() => events.publish(event));

    expect(isPanic(thrown)).toBe(true);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  function setup(input: { logger?: Logger; failing?: () => unknown } = {}) {
    const logger = mock<Logger>();
    const failing = input.failing;
    const first: (event: RunEvent) => void = failing
      ? () => {
          throw failing();
        }
      : vi.fn<(event: RunEvent) => void>();
    const second = vi.fn<(event: RunEvent) => void>();
    const event: RunEvent = {
      type: 'agentMessage',
      runId: runId(),
      role: faker.helpers.arrayElement(['planner', 'implementer', 'reviewer'] as const),
      text: faker.lorem.sentence(),
    };
    return {
      logger,
      first,
      second,
      events: observedEvents(input.logger ?? logger, [{ handle: first }, { handle: second }]),
      event,
    };
  }
});

function captured(act: () => void): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  return undefined;
}
