import { Result } from 'better-result';
import { z } from 'zod';

import { designDocsSchema } from '../domain/design-docs.js';
import type { Outcome } from '../domain/outcome.js';
import { checkPlanCoverage, PlanNotCovered } from '../domain/plan-coverage.js';
import { featurePlanSchema, runContextSchema, type RunPhase } from '../domain/run-state.js';
import { type PlannedSlice, plannedSliceSchema } from '../domain/slice.js';
import type { RunStep, StepPorts } from '../flow/define-flow.js';
import { AgentOutputInvalid, type AgentRunFailed } from '../ports/agent-session.js';
import {
  contextPrompt,
  designPrompt,
  featurePlanPrompt,
  slicePlanPrompt,
} from '../prompts/planning.js';

type SlicePlanFailure = AgentRunFailed | AgentOutputInvalid | PlanNotCovered;

export const buildContext: RunStep<RunPhase, AgentRunFailed | AgentOutputInvalid> = async ({
  state,
  ports,
}) => {
  const context = await ports.agent.runForOutput({
    role: 'planner',
    prompt: contextPrompt(state.request),
    schema: runContextSchema,
  });
  return context.map((built) => ({ type: 'contextBuilt', context: built }));
};

export const planFeature: RunStep<'planning', AgentRunFailed | AgentOutputInvalid> = async ({
  state,
  ports,
}) => {
  const plan = await ports.agent.runForOutput({
    role: 'planner',
    prompt: featurePlanPrompt(state.request, state.context.repoSummary),
    schema: featurePlanSchema,
  });
  return plan.map((planned) => ({ type: 'featurePlanned', plan: planned }));
};

export const writeDesign: RunStep<'designing', AgentRunFailed | AgentOutputInvalid> = async ({
  state,
  ports,
}) => {
  const docs = await ports.agent.runForOutput({
    role: 'planner',
    prompt: designPrompt(state.request, state.context.repoSummary, state.plan),
    schema: designDocsSchema,
  });
  return docs.map((written) => ({ type: 'designWritten', docs: written }));
};

/**
 * One correction attempt for a plan its slices do not cover; whatever survives it is the planner's
 * invalid output, so the check's PlanNotCovered surfaces as AgentOutputInvalid.
 */
export const sliceThePlan: RunStep<'slicing', AgentRunFailed | AgentOutputInvalid> = async ({
  state,
  ports,
}) => {
  const plan = state.docs.plan;
  let correction: string | undefined;
  const sliced = await ports.retryResult(() => slicePlanAttempt(plan, ports, correction), {
    retries: 1,
    delayMs: 0,
    shouldRetry: (error) => error instanceof PlanNotCovered,
    onFailedAttempt: ({ error }) => {
      if (error instanceof PlanNotCovered) correction = error.message;
    },
  });
  return sliced.mapError((error) =>
    error instanceof PlanNotCovered ? new AgentOutputInvalid({ message: error.message }) : error,
  );
};

function slicePlanAttempt(
  plan: string,
  ports: StepPorts,
  correction?: string,
): Promise<Result<Outcome, SlicePlanFailure>> {
  return Result.gen(async function* () {
    const slices = yield* Result.await(
      ports.agent.runForOutput({
        role: 'planner',
        prompt: slicePlanPrompt(plan, correction),
        schema: plannedSlicesSchema,
      }),
    );
    yield* requireUniqueIds(slices);
    yield* checkPlanCoverage(plan, slices);
    return Result.ok<Outcome>({ type: 'sliced', slices });
  });
}

const plannedSlicesSchema = z
  .array(plannedSliceSchema)
  .min(1, 'the plan must produce at least one slice');

/** Duplicate ids would make two slices share one status, so the run could never finish them both. */
function requireUniqueIds(slices: PlannedSlice[]): Result<void, AgentOutputInvalid> {
  const ids = slices.map((slice) => slice.id);
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length === 0) return Result.ok();
  return Result.err(
    new AgentOutputInvalid({
      message: `The slice plan repeats slice ids: ${[...new Set(duplicates)].join(', ')}`,
    }),
  );
}

export const applyDesignGate: RunStep<RunPhase, never> = async ({ settings }) =>
  Result.ok(settings.designGate === 'checkpoint' ? { type: 'pause' } : { type: 'continue' });
