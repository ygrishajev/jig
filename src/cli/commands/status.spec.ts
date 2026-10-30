import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';
import { aMetricsSummary, aRunState, aSlice } from '../../../tests/support/builders.js';
import type { RunState } from '../../domain/run-state.js';
import type { RunStatus } from '../../app/run-status.js';
import { runBranchFor } from '../../domain/run-state.js';
import { describeRun } from './status.js';

describe('describeRun', () => {
  it("shows the run's phase, base and branch", () => {
    const state = aRunState({ phase: 'slices' });

    const lines = describeRun(aStatus({ state })).split('\n');

    expect(lines[0]).toContain(state.runId);
    expect(lines[0]).toContain(state.phase);
    expect(lines[0]).toContain(state.baseBranch);
    expect(lines.some((line) => line.endsWith(runBranchFor(state.runId)))).toBe(true);
  });

  it('lists the slices in order with their status and the feedback the last attempt got', () => {
    const lastFeedback = faker.lorem.sentence();
    const first = aSlice({ order: 0, status: 'approved' });
    const second = aSlice({ order: 1, status: 'pending', lastFeedback });

    const shown = describeRun(aStatus({ state: aRunState({ slices: [second, first] }) }));

    expect(shown.indexOf(first.id)).toBeLessThan(shown.indexOf(second.id));
    expect(shown).toContain(`[${first.status}] ${first.id}`);
    expect(shown).toContain(lastFeedback);
  });

  it('says why a blocked run stopped and where its documents are', () => {
    const blockedReason = faker.lorem.sentence();
    const path = faker.system.filePath();

    const shown = describeRun(
      aStatus({
        state: aRunState({ blockedReason }),
        documents: [{ name: 'design.md', path }],
      }),
    );

    expect(shown).toContain(blockedReason);
    expect(shown).toContain(path);
  });

  it('shows no slice list for a run that has none yet', () => {
    const plain = describeRun(aStatus({ state: aRunState({ slices: [] }) }));
    const sliced = describeRun(aStatus({ state: aRunState({ slices: [aSlice()] }) }));

    expect(plain.split('\n').length).toBeLessThan(sliced.split('\n').length - 1);
  });
});

function aStatus({
  state,
  documents = [],
}: {
  state: RunState;
  documents?: RunStatus['documents'];
}): RunStatus {
  return { state, documents, metrics: aMetricsSummary() };
}
