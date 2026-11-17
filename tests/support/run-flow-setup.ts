import { faker } from '@faker-js/faker';
import { panic } from 'better-result';

import { LocalRunStore } from '../../src/adapters/local-store/local-run-store.js';
import { SandboxUnavailable } from '../../src/domain/errors.js';
import { type RunState, startRun } from '../../src/domain/run-state.js';
import type { RunSettings } from '../../src/domain/settings.js';
import type { PlannedSlice } from '../../src/domain/slice.js';
import { runEngine } from '../../src/flow/engine.js';
import { runFlow } from '../../src/flow/run-flow.js';
import type { ExecResult } from '../../src/ports/agent-session.js';
import type { RunStore } from '../../src/ports/run-store.js';
import { aDescription, approval, fulfillment, scriptPlanning } from './agent-scripts.js';
import {
  aContext,
  aFeaturePlan,
  aPlannedSlice,
  designDocs,
  implementingPlanSteps,
  runId,
} from './builders.js';
import { FakeAgentSession, InMemoryRunStore, RecordingEventSink, SteppingClock } from './fakes.js';
import { createRunWorktree } from './run-worktree.js';
import { tempDirectory } from './temp-directory.js';

export async function setupRunFlow(input: {
  settings: RunSettings;
  exec?: (command: string) => ExecResult | SandboxUnavailable;
  store?: RunStore;
}) {
  const id = runId();
  const { sandboxPath, workspace, git, runBranch, worktreePath, rejectCommitsInSandbox } =
    await createRunWorktree(id);
  const agent = new FakeAgentSession(sandboxPath, input.exec);
  const store = input.store ?? new InMemoryRunStore();
  const events = new RecordingEventSink();
  const dependencies = {
    ports: { agent, workspace },
    store,
    events,
    clock: new SteppingClock(),
    settings: input.settings,
  };
  const start = startRun({ runId: id, baseBranch: 'main', request: faker.lorem.paragraph() });
  const invoke = (state: RunState) => runEngine(runFlow, state, dependencies);
  const runUnder = async (settings: RunSettings, state: RunState) =>
    (await runEngine(runFlow, state, { ...dependencies, settings })).unwrap();
  const serialized = new LocalRunStore(await tempDirectory());
  const reload = async (state: RunState) => {
    (await serialized.save(state)).unwrap();
    const loaded = (await serialized.load(state.runId)).unwrap();
    if (!loaded) panic('The saved run is missing');
    return loaded;
  };
  const run = async (state: RunState) => (await invoke(state)).unwrap();
  const runBranchHistory = () =>
    git.raw(['log', '--reverse', '--format=%s', '--patch', `main..${runBranch}`]);
  return {
    agent,
    events,
    invoke,
    run,
    runUnder,
    reload,
    start,
    store,
    git,
    workspace,
    runBranch,
    worktreePath,
    runBranchHistory,
    sandboxPath,
    rejectCommitsInSandbox,
  };
}

/** Scripts the planner's context, feature plan and the design documents it writes. */
export function scriptDesign(agent: FakeAgentSession, docs = designDocs()) {
  agent.script('planner', { output: aContext() }, { output: aFeaturePlan() }, { output: docs });
  return docs;
}

/** Scripts each slice implemented and approved, the final check fulfilled, and the description. */
export function scriptDelivery(agent: FakeAgentSession, slices: PlannedSlice[]) {
  agent.script(
    'implementer',
    ...slices.map((slice) => ({ files: { [`${slice.id}.txt`]: faker.lorem.sentence() } })),
  );
  agent.script('reviewer', ...slices.map(() => approval()), fulfillment());
  agent.script('describer', aDescription());
}

/** Scripts a single-slice run whose one combined review lets it finish on reused evidence. */
export function scriptReusedRun(agent: FakeAgentSession) {
  scriptPlanning(agent, [aPlannedSlice({ description: implementingPlanSteps(1) })]);
  agent.script('implementer', { files: { 'a.txt': faker.lorem.sentence() } });
  agent.script('reviewer', approval());
  agent.script('describer', aDescription());
}

/** The reviewer's calls once the design review that every planned run starts with is done. */
export function reviewsAfterDesign(agent: FakeAgentSession) {
  return agent.calls.filter((call) => call.role === 'reviewer').slice(1);
}

export function malformedVerdict() {
  return { output: { verdict: faker.lorem.word() } };
}
