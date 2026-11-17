import { faker } from '@faker-js/faker';
import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { runId } from '../../tests/support/builders.js';
import type { RunEvent } from '../domain/events.js';
import { observedEvents } from './observed-events.js';

describe('observedEvents', () => {
  it('hands every event to every observer', () => {
    const logger = mock<Logger>();
    const first = vi.fn<(event: RunEvent) => void>();
    const second = vi.fn<(event: RunEvent) => void>();
    const events = observedEvents(logger, [{ handle: first }, { handle: second }]);
    const event = anEvent();

    events.publish(event);

    expect(first).toHaveBeenCalledWith(event);
    expect(second).toHaveBeenCalledWith(event);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('logs an observer that fails and hands the event to the others', () => {
    const logger = mock<Logger>();
    const failure = new Error(faker.lorem.sentence());
    const hearing = vi.fn<(event: RunEvent) => void>();
    const events = observedEvents(logger, [
      {
        handle: () => {
          throw failure;
        },
      },
      { handle: hearing },
    ]);
    const event = anEvent();

    events.publish(event);

    expect(logger.warn).toHaveBeenCalledWith({ err: failure }, 'an observer failed');
    expect(hearing).toHaveBeenCalledWith(event);
  });

  function anEvent(): RunEvent {
    return {
      type: 'agentMessage',
      runId: runId(),
      role: faker.helpers.arrayElement(['planner', 'implementer', 'reviewer'] as const),
      text: faker.lorem.sentence(),
    };
  }
});
