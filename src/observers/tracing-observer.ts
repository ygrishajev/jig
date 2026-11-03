import {
  type Attributes,
  context,
  type Span,
  SpanStatusCode,
  trace,
  type Tracer,
} from '@opentelemetry/api';

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

  handle(event: RunEvent): void {
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
          'jig.retry.attempt': event.attempt,
          'jig.retry.reason': event.reason,
        });
        return;
      case 'stepFinished':
        this.stepSpan?.setAttribute('jig.outcome', event.outcome.type);
        return this.endStep();
      default:
        return this.handleRunLifecycle(event);
    }
  }

  private startStep(at: StepLocation): void {
    this.stepSpan = this.tracer.startSpan(
      stepName(at),
      { attributes: locationAttributes(at) },
      this.runSpan ? trace.setSpan(context.active(), this.runSpan) : undefined,
    );
  }

  private recordAgentUsage(event: Extract<RunEvent, { type: 'agentUsage' }>): void {
    this.stepSpan?.addEvent('agent call', {
      'gen_ai.agent.name': event.role,
      'gen_ai.usage.input_tokens': event.tokens.input,
      'gen_ai.usage.output_tokens': event.tokens.output,
      'jig.usage.cache_read_tokens': event.tokens.cacheRead,
      'jig.usage.cache_write_tokens': event.tokens.cacheWrite,
      'jig.usage.reasoning_tokens': event.tokens.reasoning,
      ...(event.costUsd !== undefined ? { 'jig.usage.cost_usd': event.costUsd } : {}),
    });
  }

  private endStep(): void {
    this.stepSpan?.end();
    this.stepSpan = undefined;
  }

  private handleRunLifecycle(event: RunEvent): void {
    switch (event.type) {
      case 'runResumed':
        this.runSpan = this.tracer.startSpan('jig.run', {
          attributes: { 'jig.run_id': event.runId, 'jig.phase.start': event.phase },
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

  private endRun(phase: string): void {
    this.runSpan?.setAttribute('jig.phase.end', phase);
    this.runSpan?.end();
    this.runSpan = undefined;
  }
}

function stepName(at: StepLocation): string {
  return at.sliceId !== undefined ? `jig.step ${at.sliceStatus}` : `jig.step ${at.phase}`;
}

function locationAttributes(at: StepLocation): Attributes {
  return {
    'jig.phase': at.phase,
    ...(at.sliceId !== undefined
      ? { 'jig.slice.id': at.sliceId, 'jig.slice.status': at.sliceStatus }
      : {}),
  };
}
