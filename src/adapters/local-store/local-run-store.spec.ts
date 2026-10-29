import { faker } from '@faker-js/faker';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  aContext,
  aFeaturePlan,
  aRunState,
  aSlice,
  designDocs,
} from '../../../tests/support/builders.js';
import { LocalRunStore } from './local-run-store.js';
import { stateDirectory } from './run-paths.js';

describe('LocalRunStore', () => {
  const directories: string[] = [];

  afterEach(async () => {
    await Promise.all(
      directories.map((directory) => rm(directory, { recursive: true, force: true })),
    );
  });

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

  it('knows nothing about a run it never saved', async () => {
    const { store } = await setup();

    expect(await store.load(aRunState().runId)).toBeUndefined();
  });

  it('keeps its own directory out of the operator repository', async () => {
    const { store, repoRoot } = await setup();

    await store.save(aRunState());

    expect(await readFile(path.join(repoRoot, '.sdlc', '.gitignore'), 'utf-8')).toBe('*\n');
  });

  it('refuses a saved run that no longer matches the expected shape', async () => {
    const { store, repoRoot } = await setup();
    const state = aRunState();
    await store.save(state);
    await writeFile(
      path.join(stateDirectory(repoRoot, state.runId), 'run.json'),
      JSON.stringify({ ...state, phase: faker.word.noun() }),
    );

    await expect(store.load(state.runId)).rejects.toThrow();
  });

  async function setup() {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'sdlc-store-'));
    directories.push(repoRoot);
    return { store: new LocalRunStore(repoRoot), repoRoot };
  }
});
