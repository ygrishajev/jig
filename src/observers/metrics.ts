import type { AgentRole } from '../domain/agent-role.js';
import type { RunEvent, StepLocation } from '../domain/events.js';
import type { OutcomeType } from '../domain/outcome.js';
import type { RunId } from '../domain/run-id.js';
import type { CommitSummary, TokenUsage } from '../domain/usage.js';
import type { Clock } from '../ports/observability.js';

export type MetricRecord =
  | {
      kind: 'step';
      at: string;
      runId: RunId;
      location: StepLocation;
      outcome: OutcomeType;
      durationMs: number;
      commit?: CommitSummary;
    }
  | {
      kind: 'agentCall';
      at: string;
      runId: RunId;
      location?: StepLocation;
      role: AgentRole;
      costUsd?: number;
      tokens: TokenUsage;
    }
  | { kind: 'retry'; at: string; runId: RunId; location: StepLocation; reason: string };

export interface MetricsSummary {
  durationMs: number;
  steps: number;
  agentCalls: number;
  retries: number;
  reviewRounds: number;
  slicesCommitted: number;
  linesChanged: number;
  costUsd: number;
  tokens: TokenUsage;
}

/** Records one line per step, agent call and retry, attributing agent calls to the step they ran in. */
export class MetricsObserver {
  private location?: StepLocation;

  constructor(
    private readonly append: (record: MetricRecord) => void,
    private readonly clock: Clock,
  ) {}

  handle(event: RunEvent): void {
    const at = new Date(this.clock.now()).toISOString();
    switch (event.type) {
      case 'stepStarted':
        this.location = event.at;
        return;
      case 'stepFailed':
        this.location = undefined;
        return;
      case 'stepFinished':
        this.location = undefined;
        return this.append({
          kind: 'step',
          at,
          runId: event.runId,
          location: event.at,
          outcome: event.outcome.type,
          durationMs: event.durationMs,
          ...(event.outcome.type === 'implemented' ? { commit: event.outcome.commit } : {}),
        });
      case 'agentUsage':
        return this.append({
          kind: 'agentCall',
          at,
          runId: event.runId,
          location: this.location,
          role: event.role,
          costUsd: event.costUsd,
          tokens: event.tokens,
        });
      case 'stepRetried':
        return this.append({
          kind: 'retry',
          at,
          runId: event.runId,
          location: event.at,
          reason: event.reason,
        });
    }
  }
}

export function summarizeMetrics(records: MetricRecord[]): MetricsSummary {
  const steps = records.filter((record) => record.kind === 'step');
  const calls = records.filter((record) => record.kind === 'agentCall');
  const commits = steps.flatMap((step) => (step.commit ? [step.commit] : []));
  return {
    durationMs: sum(steps.map((step) => step.durationMs)),
    steps: steps.length,
    agentCalls: calls.length,
    retries: records.filter((record) => record.kind === 'retry').length,
    reviewRounds: steps.filter((step) => step.outcome === 'changesRequested').length,
    slicesCommitted: new Set(
      steps.flatMap((step) =>
        step.commit && step.location.sliceId !== undefined ? [step.location.sliceId] : [],
      ),
    ).size,
    linesChanged: sum(commits.map((commit) => commit.insertions + commit.deletions)),
    costUsd: sum(calls.map((call) => call.costUsd ?? 0)),
    tokens: {
      input: sum(calls.map((call) => call.tokens.input)),
      output: sum(calls.map((call) => call.tokens.output)),
      cacheRead: sum(calls.map((call) => call.tokens.cacheRead)),
      cacheWrite: sum(calls.map((call) => call.tokens.cacheWrite)),
      reasoning: sum(calls.map((call) => call.tokens.reasoning)),
    },
  };
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0);
}

/** One line for a PR footer or a status line, e.g. "2 slices · 1 review round · 412k tokens · $1.84 · 18m 3s". */
export function formatSummary(summary: MetricsSummary): string {
  const tokens =
    summary.tokens.input +
    summary.tokens.output +
    summary.tokens.cacheRead +
    summary.tokens.cacheWrite;
  return [
    plural(summary.slicesCommitted, 'slice'),
    plural(summary.reviewRounds, 'review round'),
    `${compact(tokens)} tokens`,
    `$${summary.costUsd.toFixed(2)}`,
    duration(summary.durationMs),
    ...(summary.retries > 0 ? [plural(summary.retries, 'retry', 'retries')] : []),
  ].join(' · ');
}

function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

function compact(count: number): string {
  return new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 1 })
    .format(count)
    .toLowerCase();
}

function duration(ms: number): string {
  const totalSeconds = Math.round(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
