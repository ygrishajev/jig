import { context, type Span, SpanStatusCode, trace, type Tracer } from '@opentelemetry/api';

import type { RunEvent, StepLocation } from '../domain/events.js';

/**
 * Turns run events into a trace: one span per invocation of a run, one child span per step, with
 * agent token usage and cost on the step it belongs to, named after OpenTelemetry's GenAI
 * conventions where one exists.
 */
export class TracingObserver {
  private runSpan?: Span;
  private stepSpan?: Span;

  constructor(private readonly tracer: Tracer) {}

  handle(event: RunEvent) {
    switch (event.type) {
      case 'stepStarted':
        return this.startStep(event.at);
      case 'agentUsage':
        return this.recordAgentUsage(event);
      case 'stepFailed':
        this.stepSpan?.setStatus({ code: SpanStatusCode.ERROR, message: event.reason });
        return this.endStep();
      case 'stepRetried':
        this.runSpan?.addEvent('retry', {
          'sdlc.retry.attempt': event.attempt,
          'sdlc.retry.reason': event.reason,
        });
        return;
      case 'stepFinished':
        this.stepSpan?.setAttribute('sdlc.outcome', event.outcome.type);
        return this.endStep();
      default:
        return this.handleRunLifecycle(event);
    }
  }

  private handleRunLifecycle(event: RunEvent) {
    switch (event.type) {
      case 'runResumed':
        this.runSpan = this.tracer.startSpan('sdlc.run', {
          attributes: { 'sdlc.run_id': event.runId, 'sdlc.phase.start': event.phase },
        });
        return;
      case 'runBlocked':
      case 'runFailed':
        this.runSpan?.setStatus({ code: SpanStatusCode.ERROR, message: event.reason });
        return this.endRun(event.phase);
      case 'runHalted':
      case 'runFinished':
        return this.endRun(event.phase);
    }
  }

  private startStep(at: StepLocation) {
    this.stepSpan = this.tracer.startSpan(
      stepName(at),
      { attributes: locationAttributes(at) },
      this.runSpan ? trace.setSpan(context.active(), this.runSpan) : undefined,
    );
  }

  private recordAgentUsage(event: Extract<RunEvent, { type: 'agentUsage' }>) {
    this.stepSpan?.addEvent('agent call', {
      'gen_ai.agent.name': event.role,
      'gen_ai.usage.input_tokens': event.tokens.input,
      'gen_ai.usage.output_tokens': event.tokens.output,
      'sdlc.usage.cache_read_tokens': event.tokens.cacheRead,
      'sdlc.usage.cache_write_tokens': event.tokens.cacheWrite,
      'sdlc.usage.reasoning_tokens': event.tokens.reasoning,
      ...(event.costUsd !== undefined ? { 'sdlc.usage.cost_usd': event.costUsd } : {}),
    });
  }

  private endStep() {
    this.stepSpan?.end();
    this.stepSpan = undefined;
  }

  private endRun(phase: string) {
    this.runSpan?.setAttribute('sdlc.phase.end', phase);
    this.runSpan?.end();
    this.runSpan = undefined;
  }
}

function stepName(at: StepLocation) {
  return at.sliceId !== undefined ? `sdlc.step ${at.sliceStatus}` : `sdlc.step ${at.phase}`;
}

function locationAttributes(at: StepLocation) {
  return {
    'sdlc.phase': at.phase,
    ...(at.sliceId !== undefined
      ? { 'sdlc.slice.id': at.sliceId, 'sdlc.slice.status': at.sliceStatus }
      : {}),
  };
}
