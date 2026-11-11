import { faker } from '@faker-js/faker';

import type { DesignDocs } from '../../src/domain/design-docs.js';
import type { DesignFinding, FindingDisposition } from '../../src/domain/design-review.js';
import type { PlannedSlice } from '../../src/domain/slice.js';
import {
  aContext,
  aFeaturePlan,
  aPlannedSlice,
  designDocs,
  implementingPlanSteps,
} from './builders.js';
import type { FakeAgentSession } from './fakes.js';

/**
 * Scripts the planner's four turns — context, feature plan, design docs, then `slices` — and the
 * reviewer's approval of the design in between.
 */
export function scriptPlanning(agent: FakeAgentSession, slices: PlannedSlice[]) {
  agent.script(
    'planner',
    { output: aContext() },
    { output: aFeaturePlan() },
    { output: designDocs() },
    { output: slices },
  );
  agent.script('reviewer', designApproval());
}

/** The design review's verdict: no consequential findings. */
export function designApproval() {
  return { output: { findings: [] } };
}

/** The design review's verdict: these findings stand. */
export function designFindings(...findings: DesignFinding[]) {
  return { output: { findings } };
}

/** The planner's revision: `docs` with one disposition per finding answered. */
export function designRevision(docs: DesignDocs, dispositions: FindingDisposition[]) {
  return { output: { ...docs, dispositions } };
}

/** Scripts a whole run of one slice that is implemented, approved, finally checked and described. */
export function scriptWholeRun(
  agent: FakeAgentSession,
  slice = aPlannedSlice({ description: implementingPlanSteps(1) }),
) {
  scriptPlanning(agent, [slice]);
  agent.script('implementer', { files: { [`${slice.id}.txt`]: faker.lorem.sentence() } });
  agent.script('reviewer', approval(), fulfillment());
  agent.script('describer', aDescription());
}

export function approval() {
  return { output: { approved: true, feedback: '' } };
}

/** The final check's verdict: the whole run fulfils its request. */
export function fulfillment() {
  return { output: { fulfilled: true, gaps: [] } };
}

/** The final check's verdict: the whole run still misses these requirements. */
export function unfulfilled(...gaps: string[]) {
  return { output: { fulfilled: false, gaps } };
}

export function rejection(feedback = faker.lorem.sentence()) {
  return { output: { approved: false, feedback } };
}

export function ruleFindings(feedback = faker.lorem.sentence()) {
  return { output: { approved: false, feedback, onlyRuleFindings: true } };
}

export function aDescription() {
  return { output: { body: faker.lorem.paragraph() } };
}
