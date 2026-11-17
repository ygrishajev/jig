import { faker } from '@faker-js/faker';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { runId } from '../../tests/support/builders.js';
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
    const { logger, events, event, second } = setup({ failure });

    events.publish(event);

    expect(logger.warn).toHaveBeenCalledTimes(1);
    const [record] = logger.warn.mock.calls[0];
    expect((record as { err: unknown }).err).toBe(failure);
    expect(second).toHaveBeenCalledWith(event);
  });

  function setup(input: { failure?: Error } = {}) {
    const logger = mock<Logger>();
    const failure = input.failure;
    const first: (event: RunEvent) => void = failure
      ? () => {
          throw failure;
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
      events: observedEvents(logger, [{ handle: first }, { handle: second }]),
      event,
    };
  }
});
