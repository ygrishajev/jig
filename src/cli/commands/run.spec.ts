import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import { aRunState, aSlice } from '../../../tests/support/builders.js';
import { runBranchFor } from '../../domain/run-state.js';
import { nextStep } from './run.js';

describe('nextStep', () => {
  it('asks for nothing more once the run is done', () => {
    const state = aRunState({ phase: 'done' });

    expect(nextStep({ state, status: 'done' })).not.toContain(state.runId);
  });

  it('asks for the design to be read before resuming a run paused after planning', () => {
    const state = aRunState({ phase: 'paused' });

    const step = nextStep({ state, status: 'halted' });

    expect(step).toContain(`jig run --id ${state.runId}`);
    expect(step).not.toContain(runBranchFor(state.runId));
  });

  it('names the branch to merge before resuming a run waiting to be merged', () => {
    const state = aRunState({ phase: 'awaitingMerge' });

    const step = nextStep({ state, status: 'halted' });

    expect(step).toContain(runBranchFor(state.runId));
    expect(step).toContain(`jig run --id ${state.runId}`);
  });

  it('gives the reason a blocked run stopped and how to resume it', () => {
    const reason = faker.lorem.sentence();
    const state = aRunState({ phase: 'merging', blockedReason: reason });

    const step = nextStep({ state, status: 'blocked', reason });

    expect(step).toContain(reason);
    expect(step).toContain(`jig run --id ${state.runId}`);
  });

  it('names the stuck slice and its branch, and points to status rather than a resume', () => {
    const stuck = aSlice({ status: 'stuck' });
    const state = aRunState({ phase: 'stuck', slices: [aSlice({ status: 'approved' }), stuck] });

    const step = nextStep({ state, status: 'stuck' });

    expect(step).toContain(stuck.id);
    expect(step).toContain(runBranchFor(state.runId));
    expect(step).toContain(`jig status ${state.runId}`);
    expect(step).not.toContain('jig run --id');
  });
});
