import { z } from 'zod';

import type { AgentRole } from './agent-role.js';
import type { Outcome } from './outcome.js';
import type { RunId } from './run-id.js';
import { type RunPhase, runPhaseSchema } from './run-state.js';
import { type SliceStatus, sliceStatusSchema } from './slice.js';
import type { TokenUsage } from './usage.js';

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
  | { type: 'stepFailed'; runId: RunId; at: StepLocation; reason: string; durationMs: number }
  | { type: 'stepRetried'; runId: RunId; at: StepLocation; attempt: number; reason: string }
  | { type: 'phaseChanged'; runId: RunId; from: RunPhase; to: RunPhase }
  | {
      type: 'sliceStatusChanged';
      runId: RunId;
      sliceId: string;
      from: SliceStatus;
      to: SliceStatus;
    }
  | { type: 'runHalted'; runId: RunId; phase: RunPhase }
  | { type: 'runBlocked'; runId: RunId; phase: RunPhase; reason: string }
  | { type: 'runFinished'; runId: RunId; phase: RunPhase }
  | { type: 'runFailed'; runId: RunId; phase: RunPhase; reason: string }
  | { type: 'agentMessage'; runId: RunId; role: AgentRole; text: string }
  | { type: 'agentToolCall'; runId: RunId; role: AgentRole; tool: string; args: string }
  | { type: 'agentUsage'; runId: RunId; role: AgentRole; costUsd?: number; tokens: TokenUsage };

/** Where a step ran: a run phase, or one slice's step inside it. The slice form comes first so it is not read as the bare phase. */
export const stepLocationSchema = z.union([
  z.object({ phase: runPhaseSchema, sliceId: z.string(), sliceStatus: sliceStatusSchema }),
  z.object({ phase: runPhaseSchema, sliceId: z.undefined(), sliceStatus: z.undefined() }),
]);

export type StepLocation = z.infer<typeof stepLocationSchema>;
