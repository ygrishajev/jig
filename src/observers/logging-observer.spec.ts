import { faker } from '@faker-js/faker';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import type { RunEvent } from '../domain/events.js';
import { aFeaturePlan, runId, sliceId } from '../../tests/support/builders.js';
import { LoggingObserver } from './logging-observer.js';

describe('LoggingObserver', () => {
  it('logs a finished step with its outcome and duration, keeping the event as fields', () => {
    const id = runId();
    const { observe, lines } = setup();

    observe({
      type: 'stepFinished',
      runId: id,
      at: { phase: 'planning' },
      outcome: { type: 'featurePlanned', plan: aFeaturePlan() },
      durationMs: 2500,
    });

    expect(lines()[0]).toMatchObject({
      level: 30,
      event: 'stepFinished',
      runId: id,
      msg: 'planning → featurePlanned (2.5s)',
    });
  });

  it('names the slice when a step works on one', () => {
    const id = sliceId();
    const { observe, lines } = setup();

    observe({
      type: 'stepStarted',
      runId: runId(),
      at: { phase: 'slices', sliceId: id, sliceStatus: 'in_review' },
    });

    expect(lines()[0].msg).toBe(`in_review slice ${id}…`);
  });

  it('logs a blocked run as an error with the reason', () => {
    const reason = faker.lorem.sentence();
    const { observe, lines } = setup();

    observe({ type: 'runBlocked', runId: runId(), phase: 'merging', reason });

    expect(lines()[0]).toMatchObject({ level: 50, reason });
    expect(lines()[0].msg).toContain(reason);
  });

  it('logs a retry as a warning', () => {
    const { observe, lines } = setup();

    observe({
      type: 'stepRetried',
      runId: runId(),
      at: { phase: 'context' },
      attempt: 1,
      reason: faker.lorem.sentence(),
    });

    expect(lines()[0].level).toBe(40);
  });

  function setup() {
    const written: string[] = [];
    const sink = new Writable({
      write(chunk, _encoding, done) {
        written.push(chunk.toString());
        done();
      },
    });
    const observer = new LoggingObserver(pino({ level: 'debug' }, sink));
    const observe = (event: RunEvent) => observer.handle(event);
    const lines = () => written.map((line) => JSON.parse(line));
    return { observe, lines };
  }
});
