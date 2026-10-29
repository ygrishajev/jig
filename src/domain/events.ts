import type { AgentRole } from './agent-role.js';
import type { OutcomeType } from './outcome.js';
import type { RunPhase } from './run-state.js';

export interface StepLocation {
  phase: RunPhase;
  sliceId?: string;
  sliceStatus?: string;
}

/** Everything observable about a run. Logging, metrics and tracing subscribe to these. */
export type RunEvent =
  | { type: 'runResumed'; runId: string; phase: RunPhase }
  | { type: 'stepStarted'; runId: string; at: StepLocation }
  | {
      type: 'stepFinished';
      runId: string;
      at: StepLocation;
      outcome: OutcomeType;
      durationMs: number;
    }
  | { type: 'stepRetried'; runId: string; at: StepLocation; attempt: number; reason: string }
  | { type: 'phaseChanged'; runId: string; from: RunPhase; to: RunPhase }
  | { type: 'sliceStatusChanged'; runId: string; sliceId: string; from: string; to: string }
  | { type: 'runHalted'; runId: string; phase: RunPhase }
  | { type: 'runBlocked'; runId: string; phase: RunPhase; reason: string }
  | { type: 'runFinished'; runId: string; phase: RunPhase }
  | { type: 'agentMessage'; runId: string; role: AgentRole; text: string }
  | { type: 'agentToolCall'; runId: string; role: AgentRole; tool: string; args: string };
