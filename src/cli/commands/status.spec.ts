import { faker } from '@faker-js/faker';
import { describe, expect, it } from 'vitest';

import {
  aDesignFinding,
  aMetricsSummary,
  aRunBlockedByDesignReview,
  aRunState,
  aSlice,
} from '../../../tests/support/builders.js';
import type { RunStatus } from '../../app/run-status.js';
import type { RunState } from '../../domain/run-state.js';
import { runBranchFor } from '../../domain/run-state.js';
import { formatSummary } from '../../observers/metrics.js';
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

  it('says a run that finished without merging is ready for review on its branch', () => {
    const state = aRunState({ phase: 'completed', merge: false });

    const lines = describeRun(aStatus({ state })).split('\n');

    expect(lines[0]).toContain('completed');
    expect(
      lines.some(
        (line) => line.includes('without merging') && line.includes(runBranchFor(state.runId)),
      ),
    ).toBe(true);
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

  it('names every design finding that blocks the run, and where its review report is', () => {
    const outstanding = [aDesignFinding(), aDesignFinding()];
    const state = aRunBlockedByDesignReview({ outstanding });
    const path = faker.system.filePath();

    const shown = describeRun(
      aStatus({
        state,
        documents: [{ name: 'design-review.md', path }],
      }),
    );

    for (const finding of outstanding) {
      expect(shown).toContain(finding.id);
      expect(shown).toContain(finding.recommendation);
    }
    expect(shown).toContain(path);
  });

  it('sums up the run so far once a step has run', () => {
    const metrics = aMetricsSummary({ steps: faker.number.int({ min: 1, max: 30 }) });

    const lines = describeRun(aStatus({ state: aRunState(), metrics })).split('\n');

    expect(lines.at(-1)).toContain(formatSummary(metrics));
  });

  it('shows no summary before any step has run', () => {
    const metrics = aMetricsSummary({ steps: 0 });

    expect(describeRun(aStatus({ state: aRunState(), metrics }))).not.toContain(
      formatSummary(metrics),
    );
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
  metrics = aMetricsSummary(),
}: {
  state: RunState;
  documents?: RunStatus['documents'];
  metrics?: RunStatus['metrics'];
}): RunStatus {
  return { state, documents, metrics };
}
