import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  aCompletionEvidence,
  aContext,
  aFailedVerification,
  aFeaturePlan,
  aFirstDesignReview,
  anApprovedDesignReview,
  aRejectedReview,
  aRevisedDesignReview,
  aRevisionAwaitingReReview,
  aRunState,
  aSlice,
  designDocs,
  workObservations,
} from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { RunStateInvalid } from '../../ports/run-state-failures.js';
import { LocalRunStore } from './local-run-store.js';
import { stateDirectory } from './run-paths.js';

describe('LocalRunStore', () => {
  it('loads back the run it saved', async () => {
    const { store } = await setup();
    const state = aRunState({
      phase: 'slices',
      context: aContext(),
      plan: aFeaturePlan(),
      docs: designDocs(),
      slices: [
        aSlice({
          status: 'in_review',
          lastFeedback: faker.lorem.sentence(),
          commit: faker.git.commitSha(),
        }),
      ],
    });

    await store.save(state);

    expect((await store.load(state.runId)).unwrap()).toEqual(state);
  });

  it('loads zero implementation failure counts from a legacy snapshot', async () => {
    const { store, repoRoot } = await setup();
    const state = aRunState({ slices: [aSlice({ hookFailures: 2, verificationFailures: 1 })] });
    (await store.save(state)).unwrap();
    const {
      hookFailures: _hooks,
      verificationFailures: _verification,
      ...legacySlice
    } = state.slices[0];
    await writeFile(
      path.join(stateDirectory(repoRoot, state.runId), 'run.json'),
      JSON.stringify({ ...state, slices: [legacySlice] }),
    );

    const loaded = (await store.load(state.runId)).unwrap();

    expect(loaded?.slices[0]).toEqual({ ...legacySlice, hookFailures: 0, verificationFailures: 0 });
  });

  it('loads back the completion evidence of a combined slice review and the work it observed', async () => {
    const { store } = await setup();
    const state = aRunState({
      phase: 'slices',
      docs: designDocs(),
      slices: [
        aSlice({
          status: 'in_review',
          verification: { command: `npm run ${faker.word.verb()}`, observed: workObservations() },
          failedVerification: aFailedVerification(),
          rejectedReview: aRejectedReview(),
        }),
      ],
      completionReuse: aCompletionEvidence(),
    });

    await store.save(state);

    expect((await store.load(state.runId)).unwrap()).toEqual(state);
  });

  it('loads a run saved before combined reviews recorded any completion evidence', async () => {
    const { store, repoRoot } = await setup();
    const state = aRunState({
      phase: 'slices',
      slices: [aSlice()],
      completionReuse: aCompletionEvidence(),
    });
    (await store.save(state)).unwrap();
    const { completionReuse: _neverSaved, ...legacy } = state;
    await writeFile(
      path.join(stateDirectory(repoRoot, state.runId), 'run.json'),
      JSON.stringify(legacy),
    );

    const loaded = (await store.load(state.runId)).unwrap();

    expect(loaded).toEqual(legacy);
  });

  it('peeks at the run it saved', async () => {
    const { store } = await setup();
    const state = aRunState();
    await store.save(state);

    expect((await store.peek(state.runId)).unwrap()).toEqual(state);
  });

  it('knows nothing about a run it never saved', async () => {
    const { store } = await setup();

    expect((await store.load(aRunState().runId)).unwrap()).toBeUndefined();
  });

  it('keeps its own directory out of the operator repository', async () => {
    const { store, repoRoot } = await setup();

    await store.save(aRunState());

    expect(await readFile(path.join(repoRoot, '.jig', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('refuses a saved run that no longer matches the expected shape', async () => {
    const { store, repoRoot } = await setup();
    const state = aRunState();
    await store.save(state);
    await writeFile(
      path.join(stateDirectory(repoRoot, state.runId), 'run.json'),
      JSON.stringify({ ...state, phase: faker.word.noun() }),
    );

    const loaded = await store.load(state.runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(RunStateInvalid);
  });

  it.each([
    ['revisingDesign', aFirstDesignReview()],
    ['reviewingDesign', aRevisionAwaitingReReview()],
    ['resolvingDesign', aRevisedDesignReview()],
    ['slicing', anApprovedDesignReview()],
    ['paused', anApprovedDesignReview()],
  ] as const)(
    'loads back the design review evidence of a run saved in %s',
    async (phase, designReview) => {
      const { store } = await setup();
      const state = aRunState({ phase, designReview });

      await store.save(state);

      expect((await store.load(state.runId)).unwrap()).toEqual(state);
    },
  );

  it('refuses a saved run whose design review is not the one its phase needs, naming the file', async () => {
    const { store, repoRoot } = await setup();
    const state = aRunState({ phase: 'revisingDesign' });
    await store.save(state);
    const file = path.join(stateDirectory(repoRoot, state.runId), 'run.json');
    await writeFile(file, JSON.stringify({ ...state, designReview: aRevisedDesignReview() }));

    const loaded = await store.load(state.runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(RunStateInvalid);
    expect(loaded.isErr() && loaded.error.message).toContain(file);
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-store-');
    return { store: new LocalRunStore(repoRoot), repoRoot };
  }
});
