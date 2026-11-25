import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  aDesignFinding,
  aMetricsSummary,
  anInvocationRecord,
  aRunBlockedByDesignReview,
  aRunState,
  aSlice,
  someRunDocuments,
} from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import type { InvocationStatus } from '../../domain/invocation-status.js';
import type { RunId } from '../../domain/run-id.js';
import { runStopReason } from '../../domain/run-state.js';
import { LocalRunStore } from './local-run-store.js';
import { RunArtefacts } from './run-artefacts.js';
import { stateDirectory } from './run-paths.js';

describe('RunArtefacts', () => {
  it('writes each document it is handed, and lists only the documents it wrote', async () => {
    const { artefacts, read, repoRoot } = await setup();
    const documents = someRunDocuments({ 'design-review.md': undefined });
    const invocation = anInvocationRecord({ documents });

    (await artefacts.write(invocation)).unwrap();

    const { runId } = invocation.state;
    expect(await read(runId, 'design.md')).toBe(documents['design.md']);
    expect(await read(runId, 'plan.md')).toBe(documents['plan.md']);
    expect(await read(runId, 'PR_DESCRIPTION.md')).toBe(documents['PR_DESCRIPTION.md']);
    const directory = stateDirectory(repoRoot, runId);
    expect(artefacts.documents(runId)).toEqual([
      { name: 'design.md', path: path.join(directory, 'design.md') },
      { name: 'plan.md', path: path.join(directory, 'plan.md') },
      { name: 'PR_DESCRIPTION.md', path: path.join(directory, 'PR_DESCRIPTION.md') },
    ]);
  });

  it('replaces a document written by an earlier invocation', async () => {
    const { artefacts, read } = await setup();
    const state = aRunState();
    await artefacts.write(anInvocationRecord({ state }));
    const replaced = someRunDocuments();

    (await artefacts.write(anInvocationRecord({ state, documents: replaced }))).unwrap();

    expect(await read(state.runId, 'plan.md')).toBe(replaced['plan.md']);
  });

  it.each([
    'hookFailures',
    'verificationFailures',
    'emptyAttempts',
    'ruleFixCycles',
    'reviewCycles',
  ] as const)('saves the exhausted %s budget as the terminal reason', async (counter) => {
    const { artefacts, read } = await setup();
    const state = aRunState({
      phase: 'stuck',
      slices: [aSlice({ status: 'stuck', [counter]: 3 })],
    });

    (await artefacts.write(anInvocationRecord({ state, status: 'stuck' }))).unwrap();

    expect(JSON.parse(await read(state.runId, 'result.json')).blockedReason).toBe(
      runStopReason(state),
    );
  });

  it('keeps the pull request description when the run is saved again afterwards', async () => {
    const { artefacts, read, repoRoot } = await setup();
    const invocation = anInvocationRecord();
    await artefacts.write(invocation);

    await new LocalRunStore(repoRoot).save(aRunState({ ...invocation.state, phase: 'done' }));

    expect(await read(invocation.state.runId, 'PR_DESCRIPTION.md')).toBe(
      invocation.documents['PR_DESCRIPTION.md'],
    );
  });

  it('removes a document the invocation no longer has', async () => {
    const { artefacts, repoRoot } = await setup();
    const state = aRunState();
    await artefacts.write(anInvocationRecord({ state }));

    const absent = {
      'design.md': undefined,
      'plan.md': undefined,
      'design-review.md': undefined,
      'PR_DESCRIPTION.md': undefined,
    };
    (await artefacts.write(anInvocationRecord({ state, documents: absent }))).unwrap();

    const directory = stateDirectory(repoRoot, state.runId);
    for (const name of Object.keys(absent)) {
      expect(existsSync(path.join(directory, name))).toBe(false);
    }
    expect(artefacts.documents(state.runId)).toEqual([]);
  });

  it('tells CI which design findings block the run', async () => {
    const { artefacts, read } = await setup();
    const outstanding = [aDesignFinding(), aDesignFinding()];
    const state = aRunBlockedByDesignReview({ outstanding });

    await artefacts.write(anInvocationRecord({ state, status: 'blocked' }));

    const result = JSON.parse(await read(state.runId, 'result.json'));
    expect(result).toMatchObject({
      status: 'blocked',
      phase: 'resolvingDesign',
      blockedReason: state.blockedReason,
    });
    for (const finding of outstanding) expect(result.blockedReason).toContain(finding.id);
  });

  it('summarises how a run ended for CI, naming a stuck slice', async () => {
    const { artefacts, read } = await setup();
    const stuck = aSlice({ status: 'stuck' });
    const state = aRunState({ phase: 'stuck', slices: [stuck] });
    const metrics = aMetricsSummary();

    await artefacts.write(anInvocationRecord({ state, status: 'stuck', metrics }));

    expect(JSON.parse(await read(state.runId, 'result.json'))).toEqual({
      runId: state.runId,
      status: 'stuck',
      phase: 'stuck',
      complete: false,
      blockedReason: runStopReason(state),
      metrics,
    });
  });

  it.each<{ status: InvocationStatus; complete: boolean }>([
    { status: 'done', complete: true },
    { status: 'completed', complete: true },
    { status: 'stuck', complete: false },
    { status: 'halted', complete: false },
    { status: 'blocked', complete: false },
  ])(
    'saves $status with complete=$complete and omits an absent reason',
    async ({ status, complete }) => {
      const { artefacts, read } = await setup();
      const state = aRunState({ phase: 'context' });
      const metrics = aMetricsSummary();

      (await artefacts.write(anInvocationRecord({ state, status, metrics }))).unwrap();

      expect(JSON.parse(await read(state.runId, 'result.json'))).toStrictEqual({
        runId: state.runId,
        status,
        phase: state.phase,
        complete,
        metrics,
      });
    },
  );

  it('summarises a run that finished without merging as complete', async () => {
    const { artefacts, read } = await setup();
    const state = aRunState({ phase: 'completed', merge: false });
    const metrics = aMetricsSummary();

    (await artefacts.write(anInvocationRecord({ state, status: 'completed', metrics }))).unwrap();

    expect(JSON.parse(await read(state.runId, 'result.json'))).toStrictEqual({
      runId: state.runId,
      status: 'completed',
      phase: state.phase,
      complete: true,
      metrics,
    });
  });

  it.each([faker.lorem.sentence(), ''])(
    'prefers the saved blocked reason %j over the terminal reason',
    async (blockedReason) => {
      const { artefacts, read } = await setup();
      const state = aRunState({
        phase: 'stuck',
        slices: [aSlice({ status: 'stuck' })],
        blockedReason,
      });

      (await artefacts.write(anInvocationRecord({ state, status: 'blocked' }))).unwrap();

      expect(JSON.parse(await read(state.runId, 'result.json')).blockedReason).toBe(blockedReason);
    },
  );

  it('keeps its own directory out of the operator repository', async () => {
    const { artefacts, repoRoot } = await setup();

    await artefacts.write(anInvocationRecord({ state: aRunState(), status: 'done' }));

    expect(await readFile(path.join(repoRoot, '.jig', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-artefacts-');
    const read = (runId: RunId, name: string) =>
      readFile(path.join(stateDirectory(repoRoot, runId), name), 'utf-8');
    return { artefacts: new RunArtefacts(repoRoot), read, repoRoot };
  }
});
