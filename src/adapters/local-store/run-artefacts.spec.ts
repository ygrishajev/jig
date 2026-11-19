import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  aDesignFinding,
  aMetricsSummary,
  aRevisionAwaitingReReview,
  aRunBlockedByDesignReview,
  aRunState,
  aSlice,
  designDocs,
} from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { designReviewReport } from '../../domain/design-review-report.js';
import type { InvocationStatus } from '../../domain/invocation-status.js';
import type { RunId } from '../../domain/run-id.js';
import { runStopReason } from '../../domain/run-state.js';
import { formatSummary } from '../../observers/metrics.js';
import { LocalRunStore } from './local-run-store.js';
import { RunArtefacts } from './run-artefacts.js';
import { stateDirectory } from './run-paths.js';

describe('RunArtefacts', () => {
  it('writes the design and plan for a person to read, and lists only the documents it wrote', async () => {
    const { artefacts, read, repoRoot } = await setup();
    const docs = designDocs();
    const state = aRunState({ docs });

    await artefacts.write(state, 'halted', aMetricsSummary());

    expect(await read(state.runId, 'design.md')).toBe(docs.design);
    expect(await read(state.runId, 'plan.md')).toBe(docs.plan);
    const directory = stateDirectory(repoRoot, state.runId);
    expect(artefacts.documents(state.runId)).toEqual([
      { name: 'design.md', path: path.join(directory, 'design.md') },
      { name: 'plan.md', path: path.join(directory, 'plan.md') },
    ]);
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

    (await artefacts.write(state, 'stuck', aMetricsSummary())).unwrap();

    expect(JSON.parse(await read(state.runId, 'result.json')).blockedReason).toBe(
      runStopReason(state),
    );
  });

  it('closes the pull request description with the run so far', async () => {
    const { artefacts, read } = await setup();
    const prDescription = faker.lorem.paragraphs();
    const metrics = aMetricsSummary();
    const state = aRunState({ prDescription });

    await artefacts.write(state, 'halted', metrics);

    const written = await read(state.runId, 'PR_DESCRIPTION.md');
    expect(written.startsWith(prDescription)).toBe(true);
    expect(written).toContain(formatSummary(metrics));
  });

  it('keeps the footer when the run is saved again afterwards', async () => {
    const { artefacts, read, repoRoot } = await setup();
    const metrics = aMetricsSummary();
    const state = aRunState({ prDescription: faker.lorem.paragraphs() });
    await artefacts.write(state, 'halted', metrics);

    await new LocalRunStore(repoRoot).save(aRunState({ ...state, phase: 'done' }));

    expect(await read(state.runId, 'PR_DESCRIPTION.md')).toContain(formatSummary(metrics));
  });

  it('removes a document the run no longer has', async () => {
    const { artefacts, repoRoot } = await setup();
    const state = aRunState({
      phase: 'reviewingDesign',
      designReview: aRevisionAwaitingReReview(),
      prDescription: faker.lorem.paragraph(),
    });
    await artefacts.write(state, 'halted', aMetricsSummary());

    await artefacts.write(aRunState({ runId: state.runId }), 'halted', aMetricsSummary());

    const directory = stateDirectory(repoRoot, state.runId);
    for (const name of ['design.md', 'plan.md', 'design-review.md', 'PR_DESCRIPTION.md']) {
      expect(existsSync(path.join(directory, name))).toBe(false);
    }
  });

  it('exports a design review in progress with the revised documents, listed after the plan', async () => {
    const { artefacts, read, repoRoot } = await setup();
    const state = aRunState({
      phase: 'reviewingDesign',
      designReview: aRevisionAwaitingReReview(),
      blockedReason: faker.lorem.sentence(),
    });

    await artefacts.write(state, 'blocked', aMetricsSummary());

    expect(await read(state.runId, 'design-review.md')).toBe(designReviewReport(state));
    expect(await read(state.runId, 'design.md')).toBe(state.docs?.design);
    const directory = stateDirectory(repoRoot, state.runId);
    expect(artefacts.documents(state.runId)).toEqual([
      { name: 'design.md', path: path.join(directory, 'design.md') },
      { name: 'plan.md', path: path.join(directory, 'plan.md') },
      { name: 'design-review.md', path: path.join(directory, 'design-review.md') },
    ]);
  });

  it('tells CI which design findings block the run', async () => {
    const { artefacts, read } = await setup();
    const outstanding = [aDesignFinding(), aDesignFinding()];
    const state = aRunBlockedByDesignReview({ outstanding });

    await artefacts.write(state, 'blocked', aMetricsSummary());

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

    await artefacts.write(state, 'stuck', metrics);

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

      (await artefacts.write(state, status, metrics)).unwrap();

      expect(JSON.parse(await read(state.runId, 'result.json'))).toStrictEqual({
        runId: state.runId,
        status,
        phase: state.phase,
        complete,
        metrics,
      });
    },
  );

  it('prefers the saved blocked reason over the terminal reason', async () => {
    const { artefacts, read } = await setup();
    const blockedReason = faker.lorem.sentence();
    const state = aRunState({
      phase: 'stuck',
      slices: [aSlice({ status: 'stuck' })],
      blockedReason,
    });

    (await artefacts.write(state, 'blocked', aMetricsSummary())).unwrap();

    expect(JSON.parse(await read(state.runId, 'result.json')).blockedReason).toBe(blockedReason);
  });

  it('keeps its own directory out of the operator repository', async () => {
    const { artefacts, repoRoot } = await setup();

    await artefacts.write(aRunState(), 'done', aMetricsSummary());

    expect(await readFile(path.join(repoRoot, '.jig', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-artefacts-');
    const read = (runId: RunId, name: string) =>
      readFile(path.join(stateDirectory(repoRoot, runId), name), 'utf-8');
    return { artefacts: new RunArtefacts(repoRoot), read, repoRoot };
  }
});
