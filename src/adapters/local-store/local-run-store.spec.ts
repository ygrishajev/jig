import { faker } from '@faker-js/faker';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ZodError } from 'zod';

import {
  aContext,
  aFeaturePlan,
  aRunState,
  aSlice,
  designDocs,
} from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
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

    expect(await store.load(state.runId)).toEqual(state);
  });

  it('peeks at the run it saved', async () => {
    const { store } = await setup();
    const state = aRunState();
    await store.save(state);

    expect(await store.peek(state.runId)).toEqual(state);
  });

  it('knows nothing about a run it never saved', async () => {
    const { store } = await setup();

    expect(await store.load(aRunState().runId)).toBeUndefined();
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

    await expect(store.load(state.runId)).rejects.toBeInstanceOf(ZodError);
  });

  async function setup() {
    const repoRoot = await tempDirectory('jig-store-');
    return { store: new LocalRunStore(repoRoot), repoRoot };
  }
});
