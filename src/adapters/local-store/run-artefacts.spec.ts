import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import { aMetricsSummary, aRunState, aSlice, designDocs } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import type { RunId } from '../../domain/run-id.js';
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
    const state = aRunState({ docs: designDocs(), prDescription: faker.lorem.paragraph() });
    await artefacts.write(state, 'halted', aMetricsSummary());

    await artefacts.write(aRunState({ runId: state.runId }), 'halted', aMetricsSummary());

    const directory = stateDirectory(repoRoot, state.runId);
    for (const name of ['design.md', 'plan.md', 'PR_DESCRIPTION.md']) {
      expect(existsSync(path.join(directory, name))).toBe(false);
    }
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
      blockedReason: `slice "${stuck.id}" is stuck — needs human intervention`,
      metrics,
    });
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
