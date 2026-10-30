import { faker } from '@faker-js/faker';
import type { PlannedSlice } from '../../src/domain/slice.js';
import { aContext, aFeaturePlan, aPlannedSlice, designDocs } from './builders.js';
import type { FakeAgentSession } from './fakes.js';

/** Scripts the planner's four turns: context, feature plan, design docs, then `slices`. */
export function scriptPlanning(agent: FakeAgentSession, slices: PlannedSlice[]) {
  agent.script(
    'planner',
    { output: aContext() },
    { output: aFeaturePlan() },
    { output: designDocs() },
    { output: slices },
  );
}

/** Scripts a whole run of one slice that is implemented, approved and described. */
export function scriptWholeRun(agent: FakeAgentSession, slice = aPlannedSlice()) {
  scriptPlanning(agent, [slice]);
  agent.script('implementer', { files: { [`${slice.id}.txt`]: faker.lorem.sentence() } });
  agent.script('reviewer', approval());
  agent.script('describer', aDescription());
}

export function approval() {
  return { output: { approved: true, feedback: '' } };
}

export function rejection(feedback = faker.lorem.sentence()) {
  return { output: { approved: false, feedback } };
}

export function aDescription() {
  return { output: { body: faker.lorem.paragraph() } };
}
