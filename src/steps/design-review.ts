import {
  designReReview,
  designReviewSchema,
  designRevisionSchemaFor,
  findingsToRevise,
  resolveDesignReview,
} from '../domain/design-review.js';
import type { RunStateIn } from '../domain/run-state.js';
import type { RunStep } from '../flow/define-flow.js';
import {
  type DesignInputs,
  designReReviewPrompt,
  designReviewPrompt,
  designRevisionPrompt,
} from '../prompts/design-review.js';

/**
 * Has a fresh reviewer check the design and plan before slicing: the documents as written, or —
 * once the planner has revised them — the revision against the findings and dispositions.
 */
export const reviewDesign: RunStep<'reviewingDesign'> = async ({ state, ports }) => {
  const inputs = designInputs(state);
  const reReview = designReReview(state);
  const review = await ports.agent.runForOutput({
    role: 'reviewer',
    prompt: reReview
      ? designReReviewPrompt({ ...inputs, ...reReview })
      : designReviewPrompt(inputs),
    schema: designReviewSchema,
  });
  return review.map((reviewed) => ({ type: 'designReviewed', review: reviewed }));
};

function designInputs(state: RunStateIn<'reviewingDesign' | 'revisingDesign'>): DesignInputs {
  return {
    request: state.request,
    repoSummary: state.context.repoSummary,
    plan: state.plan,
    docs: state.docs,
  };
}

/** The planner's one revision: revised documents and a disposition for every finding. */
export const reviseDesign: RunStep<'revisingDesign'> = async ({ state, ports }) => {
  const findings = findingsToRevise(state.designReview);
  const revision = await ports.agent.runForOutput({
    role: 'planner',
    prompt: designRevisionPrompt({ ...designInputs(state), findings }),
    schema: designRevisionSchemaFor(findings),
  });
  return revision.map((revised) => ({ type: 'designRevised', revision: revised }));
};

/** Lets a reviewed design on to slicing, or blocks the run on the findings still standing. */
export const resolveDesign: RunStep<'resolvingDesign'> = async ({ state }) =>
  resolveDesignReview(state.designReview).map(() => ({ type: 'continue' }));
