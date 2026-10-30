import { faker } from '@faker-js/faker';
import { SpanStatusCode } from '@opentelemetry/api';
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-base';
import { describe, expect, it } from 'vitest';

import { aFeaturePlan, anImplementation, runId, sliceId } from '../../tests/support/builders.js';
import type { RunEvent, StepLocation } from '../domain/events.js';
import { TracingObserver } from './tracing-observer.js';

describe('TracingObserver', () => {
  it('ends a halted run without marking it as an error', () => {
    const { observe, spans } = setup();
    const id = runId();
    observe({ type: 'runResumed', runId: id, phase: 'planning' });
    observe({ type: 'runHalted', runId: id, phase: 'designing' });
    expect(spans()).toEqual([
      expect.objectContaining({
        attributes: expect.objectContaining({ 'sdlc.phase.end': 'designing' }),
        status: { code: SpanStatusCode.UNSET },
      }),
    ]);
  });

  it('nests each step under the run, with its outcome', () => {
    const { observe, spans } = setup();
    const id = runId();

    observe({ type: 'runResumed', runId: id, phase: 'planning' });
    observe({ type: 'stepStarted', runId: id, at: { phase: 'planning' } });
    observe({
      type: 'stepFinished',
      runId: id,
      at: { phase: 'planning' },
      outcome: { type: 'featurePlanned', plan: aFeaturePlan() },
      durationMs: 1,
    });
    observe({ type: 'runFinished', runId: id, phase: 'done' });

    const [step, run] = spans();
    expect(run).toMatchObject({
      name: 'sdlc.run',
      attributes: { 'sdlc.run_id': id, 'sdlc.phase.end': 'done' },
    });
    expect(step).toMatchObject({
      name: 'sdlc.step planning',
      attributes: { 'sdlc.outcome': 'featurePlanned' },
    });
    expect(step.parentSpanContext?.spanId).toBe(run.spanContext().spanId);
  });

  it("puts an agent call's tokens and cost on the step it ran in", () => {
    const { observe, spans } = setup();
    const id = runId();
    const at: StepLocation = { phase: 'slices', sliceId: sliceId(), sliceStatus: 'pending' };
    const input = faker.number.int({ min: 1, max: 9999 });
    const costUsd = faker.number.float({ min: 0.01, max: 1, fractionDigits: 4 });

    observe({ type: 'runResumed', runId: id, phase: 'slices' });
    observe({ type: 'stepStarted', runId: id, at });
    observe({
      type: 'agentUsage',
      runId: id,
      role: 'implementer',
      costUsd,
      tokens: { input, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
    });
    observe({
      type: 'stepFinished',
      runId: id,
      at,
      outcome: anImplementation(),
      durationMs: 1,
    });

    expect(spans()[0].events[0]).toMatchObject({
      name: 'agent call',
      attributes: {
        'gen_ai.agent.name': 'implementer',
        'gen_ai.usage.input_tokens': input,
        'sdlc.usage.cost_usd': costUsd,
      },
    });
  });

  it('ends every attempt of a retried step, marking the failed ones as errors', () => {
    const { observe, spans } = setup();
    const id = runId();
    const at: StepLocation = { phase: 'planning' };
    const reason = faker.lorem.sentence();

    observe({ type: 'runResumed', runId: id, phase: 'planning' });
    observe({ type: 'stepStarted', runId: id, at });
    observe({ type: 'stepFailed', runId: id, at, reason, durationMs: 1 });
    observe({ type: 'stepRetried', runId: id, at, attempt: 1, reason });
    observe({ type: 'stepStarted', runId: id, at });
    observe({
      type: 'stepFinished',
      runId: id,
      at,
      outcome: { type: 'featurePlanned', plan: aFeaturePlan() },
      durationMs: 1,
    });

    const [failed, succeeded] = spans();
    expect(failed.status).toEqual({ code: SpanStatusCode.ERROR, message: reason });
    expect(succeeded.attributes).toMatchObject({ 'sdlc.outcome': 'featurePlanned' });
  });

  it('ends the failed step of a blocked run before the run itself', () => {
    const { observe, spans } = setup();
    const id = runId();
    const reason = faker.lorem.sentence();

    observe({ type: 'runResumed', runId: id, phase: 'merging' });
    observe({ type: 'stepStarted', runId: id, at: { phase: 'merging' } });
    observe({ type: 'stepFailed', runId: id, at: { phase: 'merging' }, reason, durationMs: 1 });
    observe({ type: 'runBlocked', runId: id, phase: 'merging', reason });

    expect(spans().map((span) => span.name)).toEqual(['sdlc.step merging', 'sdlc.run']);
  });

  it('marks a blocked run as an error with the reason', () => {
    const { observe, spans } = setup();
    const reason = faker.lorem.sentence();
    const id = runId();

    observe({ type: 'runResumed', runId: id, phase: 'merging' });
    observe({ type: 'runBlocked', runId: id, phase: 'merging', reason });

    expect(spans()[0].status).toEqual({ code: SpanStatusCode.ERROR, message: reason });
  });

  it('ends a run that failed fatally as an error with the reason', () => {
    const { observe, spans } = setup();
    const reason = faker.lorem.sentence();
    const id = runId();

    observe({ type: 'runResumed', runId: id, phase: 'slices' });
    observe({ type: 'runFailed', runId: id, phase: 'slices', reason });

    expect(spans()[0]).toMatchObject({
      name: 'sdlc.run',
      status: { code: SpanStatusCode.ERROR, message: reason },
      attributes: { 'sdlc.phase.end': 'slices' },
    });
  });

  function setup() {
    const exporter = new InMemorySpanExporter();
    const provider = new BasicTracerProvider({
      spanProcessors: [new SimpleSpanProcessor(exporter)],
    });
    const observer = new TracingObserver(provider.getTracer('test'));
    return {
      observe: (event: RunEvent) => observer.handle(event),
      spans: () => exporter.getFinishedSpans(),
    };
  }
});
