import { z } from 'zod';
import { AgentOutputInvalid } from '../domain/errors.js';
import { produced } from '../domain/run-state.js';
import { SLICE_ID_PATTERN } from '../domain/slice.js';
import type { RunStep } from '../flow/define-flow.js';
import {
  contextPrompt,
  designPrompt,
  featurePlanPrompt,
  slicePlanPrompt,
} from '../prompts/planning.js';

const contextSchema = z.object({ classification: z.string(), repoSummary: z.string() });

const featurePlanSchema = z.object({
  summary: z.string(),
  approach: z.string(),
  affectedAreas: z.array(z.string()),
});

const designDocsSchema = z.object({ design: z.string().min(1), plan: z.string().min(1) });

const plannedSlicesSchema = z
  .array(
    z.object({
      id: z
        .string()
        .regex(SLICE_ID_PATTERN, 'slice id must be lowercase letters, digits and hyphens'),
      title: z.string().min(1),
      description: z.string().min(1),
    }),
  )
  .min(1, 'the plan must produce at least one slice');

export const buildContext: RunStep = async ({ state, ports }) => {
  const context = await ports.agent.runForOutput({
    role: 'planner',
    prompt: contextPrompt(state.request),
    schema: contextSchema,
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
