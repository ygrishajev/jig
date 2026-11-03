import { faker } from '@faker-js/faker';
import { isPanic, panic } from 'better-result';
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

  it('keeps the run going when an observer fails', () => {
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

  it('lets a bug in an observer through', () => {
    const events = new RunEvents();
    observe(
      events,
      () => panic(faker.lorem.sentence()),
      () => {},
    );
    const event: RunEvent = { type: 'runFinished', runId: runId(), phase: 'done' };

    expect(isPanic(captured(() => events.publish(event)))).toBe(true);
  });
});

function captured(act: () => void): unknown {
  try {
    act();
  } catch (error) {
    return error;
  }
  return undefined;
}
