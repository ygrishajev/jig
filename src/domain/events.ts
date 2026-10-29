import type { AgentRole } from './agent-role.js';
import type { Outcome } from './outcome.js';
import type { RunId } from './run-id.js';
import type { RunPhase } from './run-state.js';
import type { TokenUsage } from './usage.js';

export interface StepLocation {
  phase: RunPhase;
  sliceId?: string;
  sliceStatus?: string;
}

/** Everything observable about a run. Logging, metrics and tracing subscribe to these. */
export type RunEvent =
  | { type: 'runResumed'; runId: RunId; phase: RunPhase }
  | { type: 'stepStarted'; runId: RunId; at: StepLocation }
  | {
      type: 'stepFinished';
      runId: RunId;
      at: StepLocation;
      outcome: Outcome;
      durationMs: number;
    }
  | { type: 'stepRetried'; runId: RunId; at: StepLocation; attempt: number; reason: string }
  | { type: 'phaseChanged'; runId: RunId; from: RunPhase; to: RunPhase }
  | { type: 'sliceStatusChanged'; runId: RunId; sliceId: string; from: string; to: string }
  | { type: 'runHalted'; runId: RunId; phase: RunPhase }
  | { type: 'runBlocked'; runId: RunId; phase: RunPhase; reason: string }
  | { type: 'runFinished'; runId: RunId; phase: RunPhase }
  | { type: 'agentMessage'; runId: RunId; role: AgentRole; text: string }
  | { type: 'agentToolCall'; runId: RunId; role: AgentRole; tool: string; args: string }
  | { type: 'agentUsage'; runId: RunId; role: AgentRole; costUsd?: number; tokens: TokenUsage };
