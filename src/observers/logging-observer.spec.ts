import { faker } from '@faker-js/faker';
import { Writable } from 'node:stream';
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';

import { aFeaturePlan, runId, sliceId } from '../../tests/support/builders.js';
import type { RunEvent, StepLocation } from '../domain/events.js';
import { LoggingObserver } from './logging-observer.js';

describe('LoggingObserver', () => {
  it.each(['runResumed', 'runHalted', 'runFinished'] as const)(
    'logs %s at info with the run and phase',
    (type) => {
      const { observe, lines } = setup();
      const id = runId();
      observe({ type, runId: id, phase: 'planning' });
      expect(lines()).toEqual([
        expect.objectContaining({ level: 30, event: type, runId: id, phase: 'planning' }),
      ]);
    },
  );

  it('logs a finished step at info, keeping the event as fields', () => {
    const id = runId();
    const durationMs = faker.number.int({ min: 1, max: 60_000 });
    const { observe, lines } = setup();

    observe({
      type: 'stepFinished',
      runId: id,
      at: { phase: 'planning' },
      outcome: { type: 'featurePlanned', plan: aFeaturePlan() },
      durationMs,
    });

    expect(lines()[0]).toMatchObject({
      level: 30,
      event: 'stepFinished',
      runId: id,
      at: { phase: 'planning' },
      outcome: { type: 'featurePlanned' },
      durationMs,
    });
  });

  it('keeps the slice a step works on as fields', () => {
    const at: StepLocation = { phase: 'slices', sliceId: sliceId(), sliceStatus: 'in_review' };
    const { observe, lines } = setup();

    observe({ type: 'stepStarted', runId: runId(), at });

    expect(lines()[0]).toMatchObject({ level: 30, event: 'stepStarted', at });
  });

  it('logs a failed attempt at debug, since the retry or block that follows says what matters', () => {
    const reason = faker.lorem.sentence();
    const { observe, lines } = setup();

    observe({
      type: 'stepFailed',
      runId: runId(),
      at: { phase: 'context' },
      reason,
      durationMs: 1,
    });

    expect(lines()[0]).toMatchObject({ level: 20, event: 'stepFailed', reason });
  });

  it('logs a blocked run as an error with the reason', () => {
    const reason = faker.lorem.sentence();
    const { observe, lines } = setup();

    observe({ type: 'runBlocked', runId: runId(), phase: 'merging', reason });

    expect(lines()[0]).toMatchObject({ level: 50, event: 'runBlocked', reason });
  });

  it('logs a fatally failed run as an error with the reason', () => {
    const reason = faker.lorem.sentence();
    const id = runId();
    const { observe, lines } = setup();

    observe({ type: 'runFailed', runId: id, phase: 'slices', reason });

    expect(lines()[0]).toMatchObject({ level: 50, event: 'runFailed', runId: id, reason });
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
