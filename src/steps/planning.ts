import { z } from 'zod';
import { AgentOutputInvalid } from '../domain/errors.js';
import {
  designDocsSchema,
  featurePlanSchema,
  produced,
  runContextSchema,
} from '../domain/run-state.js';
import { plannedSliceSchema } from '../domain/slice.js';
import type { RunStep } from '../flow/define-flow.js';
import {
  contextPrompt,
  designPrompt,
  featurePlanPrompt,
  slicePlanPrompt,
} from '../prompts/planning.js';

const plannedSlicesSchema = z
  .array(plannedSliceSchema)
  .min(1, 'the plan must produce at least one slice');

export const buildContext: RunStep = async ({ state, ports }) => {
  const context = await ports.agent.runForOutput({
    role: 'planner',
    prompt: contextPrompt(state.request),
    schema: runContextSchema,
  });
  return { type: 'contextBuilt', context };
};

export const planFeature: RunStep = async ({ state, ports }) => {
  const plan = await ports.agent.runForOutput({
    role: 'planner',
    prompt: featurePlanPrompt(state.request, produced(state, 'context').repoSummary),
    schema: featurePlanSchema,
  });
  return { type: 'featurePlanned', plan };
};

export const writeDesign: RunStep = async ({ state, ports }) => {
  const docs = await ports.agent.runForOutput({
    role: 'planner',
    prompt: designPrompt(
      state.request,
      produced(state, 'context').repoSummary,
      produced(state, 'plan'),
    ),
    schema: designDocsSchema,
  });
  return { type: 'designWritten', docs };
};

export const sliceThePlan: RunStep = async ({ state, ports }) => {
  const slices = await ports.agent.runForOutput({
    role: 'planner',
    prompt: slicePlanPrompt(produced(state, 'docs').plan),
    schema: plannedSlicesSchema,
  });
  assertUniqueIds(slices.map((slice) => slice.id));
  return { type: 'sliced', slices };
};

export const applyDesignGate: RunStep = async ({ settings }) =>
  settings.designGate === 'checkpoint' ? { type: 'pause' } : { type: 'continue' };

/** Duplicate ids would make two slices share one status, so the run could never finish them both. */
function assertUniqueIds(ids: string[]) {
  const duplicates = ids.filter((id, index) => ids.indexOf(id) !== index);
  if (duplicates.length > 0) {
    throw new AgentOutputInvalid(
      `The slice plan repeats slice ids: ${[...new Set(duplicates)].join(', ')}`,
    );
  }
}
