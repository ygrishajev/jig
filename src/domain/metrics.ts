import type { AgentRole } from './agent-role.js';
import type { StepLocation } from './events.js';
import type { OutcomeType } from './outcome.js';
import type { RunId } from './run-id.js';
import type { CommitSummary, TokenUsage } from './usage.js';

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

export function summarizeMetrics(records: MetricRecord[]): MetricsSummary {
  const steps = records.filter((record) => record.kind === 'step');
  const calls = records.filter((record) => record.kind === 'agentCall');
  const commits = steps.flatMap((step) => (step.commit ? [step.commit] : []));
  return {
    durationMs: sum(steps.map((step) => step.durationMs)),
    steps: steps.length,
    agentCalls: calls.length,
    retries: records.filter((record) => record.kind === 'retry').length,
    reviewRounds: steps.filter((step) => REVIEW_REJECTIONS.has(step.outcome)).length,
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

/** Outcomes that send a slice back to its implementer with feedback. */
const REVIEW_REJECTIONS: ReadonlySet<OutcomeType> = new Set([
  'changesRequested',
  'rulesFixRequested',
]);
