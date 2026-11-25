import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { Command } from 'commander';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import {
  aDesignFinding,
  aMetricsSummary,
  aRunBlockedByDesignReview,
  aRunState,
  aSlice,
  runId,
} from '../../../tests/support/builders.js';
import { type JigOperations, RunRequestInvalid, type RunStatus } from '../../app/api.js';
import type { RunState } from '../../domain/run-state.js';
import { runBranchFor } from '../../domain/run-state.js';
import type { FailureOutput } from '../with-error-handling.js';
import { describeRun, registerStatusCommand } from './status.js';

describe('status command', () => {
  it('asks for the run it was given, read through the config file it was given', async () => {
    const { run, status, output } = setup();
    const id = runId();
    const config = `${faker.word.noun()}.json`;

    await run([id, '--config', config]);

    expect(status).toHaveBeenCalledWith({ runId: id, configPath: config });
    expect(output.setExitCode).not.toHaveBeenCalled();
  });

  it('refuses a run id it cannot parse without asking for a status', async () => {
    const { run, status, output } = setup();

    await run([faker.string.alpha({ casing: 'upper', length: 8 })]);

    expect(status).not.toHaveBeenCalled();
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });

  it("prints the operation's failure and exits with 1", async () => {
    const failure = new RunRequestInvalid({ message: faker.lorem.sentence() });
    const { run, output } = setup({ found: Result.err(failure) });

    await run([runId()]);

    expect(output.printError).toHaveBeenCalledWith(failure.message);
    expect(output.setExitCode).toHaveBeenCalledWith(1);
  });

  function setup({
    found = Result.ok(aStatus({ state: aRunState() })),
  }: { found?: Awaited<ReturnType<JigOperations['status']>> } = {}) {
    const status = vi.fn<JigOperations['status']>(async () => found);
    const output = mock<FailureOutput>();
    const program = new Command();
    registerStatusCommand(program, status, output);
    return {
      status,
      output,
      run: (args: string[]) => program.parseAsync(['status', ...args], { from: 'user' }),
    };
  }
});

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
    const metricsLine = faker.lorem.sentence();
    const metrics = aMetricsSummary({ steps: faker.number.int({ min: 1, max: 30 }) });

    const lines = describeRun(aStatus({ state: aRunState(), metrics, metricsLine })).split('\n');

    expect(lines.at(-1)).toBe(`So far: ${metricsLine}`);
  });

  it('shows no summary before any step has run', () => {
    const metricsLine = faker.lorem.sentence();
    const metrics = aMetricsSummary({ steps: 0 });

    const shown = describeRun(aStatus({ state: aRunState(), metrics, metricsLine }));

    expect(shown).not.toContain(metricsLine);
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
  metricsLine = faker.lorem.sentence(),
}: Partial<RunStatus> & { state: RunState }): RunStatus {
  return { state, documents, metrics, metricsLine };
}
