import { z } from 'zod';

import { AgentOutputInvalid, orThrow } from '../domain/errors.js';
import { designDocsSchema, featurePlanSchema, runContextSchema } from '../domain/run-state.js';
import { plannedSliceSchema } from '../domain/slice.js';
import type { RunStep } from '../flow/define-flow.js';
import {
  contextPrompt,
  designPrompt,
  featurePlanPrompt,
  slicePlanPrompt,
} from '../prompts/planning.js';

export const buildContext: RunStep = async ({ state, ports }) => {
  const context = orThrow(
    await ports.agent.runForOutput({
      role: 'planner',
      prompt: contextPrompt(state.request),
      schema: runContextSchema,
    }),
  );
  return { type: 'contextBuilt', context };
};

export const planFeature: RunStep<'planning'> = async ({ state, ports }) => {
  const plan = orThrow(
    await ports.agent.runForOutput({
      role: 'planner',
      prompt: featurePlanPrompt(state.request, state.context.repoSummary),
      schema: featurePlanSchema,
    }),
  );
  return { type: 'featurePlanned', plan };
};

export const writeDesign: RunStep<'designing'> = async ({ state, ports }) => {
  const docs = orThrow(
    await ports.agent.runForOutput({
      role: 'planner',
      prompt: designPrompt(state.request, state.context.repoSummary, state.plan),
      schema: designDocsSchema,
    }),
  );
  return { type: 'designWritten', docs };
};

export const sliceThePlan: RunStep<'slicing'> = async ({ state, ports }) => {
  const slices = orThrow(
    await ports.agent.runForOutput({
      role: 'planner',
      prompt: slicePlanPrompt(state.docs.plan),
      schema: plannedSlicesSchema,
    }),
  );
  assertUniqueIds(slices.map((slice) => slice.id));
  return { type: 'sliced', slices };
};

const plannedSlicesSchema = z
  .array(plannedSliceSchema)
  .min(1, 'the plan must produce at least one slice');

/** Duplicate ids would make two slices share one status, so the run could never finish them both. */
function assertUniqueIds(ids: string[]): void {
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new AgentOutputInvalid({
      message: `The slice plan repeats slice ids: ${[...new Set(duplicates)].join(', ')}`,
    });
  }
}

export const applyDesignGate: RunStep = async ({ settings }) =>
  settings.designGate === 'checkpoint' ? { type: 'pause' } : { type: 'continue' };
