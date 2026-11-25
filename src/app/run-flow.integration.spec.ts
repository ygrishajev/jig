import { describe, expect, it } from 'vitest';

import { scriptDelivery, scriptPlanning } from '../../tests/support/agent-scripts.js';
import {
  aPlannedSlice,
  aRunState,
  implementingPlanSteps,
  runId,
  runSettings,
} from '../../tests/support/builders.js';
import { InMemoryRunStore, RecordingEventSink, SteppingClock } from '../../tests/support/fakes.js';
import { createRunWorktree } from '../../tests/support/run-worktree.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { runEngine } from '../flow/engine.js';
import { runFlow } from './run-flow.js';

describe('runFlow on real git', () => {
  it("merges every slice's commit into the base branch", async () => {
    const id = runId();
    const slices = [1, 2].map(() => aPlannedSlice({ description: implementingPlanSteps(1) }));
    const { agent, workspace, git } = await createRunWorktree(id);
    scriptPlanning(agent, slices);
    scriptDelivery(agent, slices);

    const { status } = unwrap(
      await runEngine(runFlow, aRunState({ runId: id }), {
        ports: { agent, workspace },
        store: new InMemoryRunStore(),
        events: new RecordingEventSink(),
        clock: new SteppingClock(),
        settings: runSettings({ mergeMode: 'auto' }),
      }),
    );

    expect(status).toBe('done');
    const merged = await git.log(['main']);
    expect(merged.all.map((commit) => commit.message)).toEqual(
      expect.arrayContaining(slices.map((slice) => slice.title)),
    );
  });
});
