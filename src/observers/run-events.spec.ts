import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { runId } from '../../tests/support/builders.js';
import type { RunEvent } from '../domain/events.js';
import { observe, RunEvents } from './run-events.js';

describe('RunEvents', () => {
  it('hands every published event to its listeners, in order', () => {
    const events = new RunEvents();
    const received: RunEvent[] = [];
    events.on('event', (event) => received.push(event));
    const finished: RunEvent = { type: 'runFinished', runId: runId(), phase: 'done' };
    const blocked: RunEvent = {
      type: 'runBlocked',
      runId: runId(),
      phase: 'merging',
      reason: faker.lorem.sentence(),
    };

    events.publish(finished);
    events.publish(blocked);

    expect(received).toEqual([finished, blocked]);
  });

  it('keeps notifying the other observers when one of them throws', () => {
    const events = new RunEvents();
    const received: RunEvent[] = [];
    const failures: unknown[] = [];
    observe(
      events,
      () => {
        throw new Error(faker.lorem.sentence());
      },
      (error) => failures.push(error),
    );
    observe(
      events,
      (event) => received.push(event),
      (error) => failures.push(error),
    );
    const event: RunEvent = { type: 'runFinished', runId: runId(), phase: 'done' };

    expect(() => events.publish(event)).not.toThrow();
    expect(received).toEqual([event]);
    expect(failures).toHaveLength(1);
  });
});
