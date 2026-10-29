import { faker } from '@faker-js/faker';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
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
          startCommit: faker.git.commitSha(),
          commit: faker.git.commitSha(),
        }),
      ],
    });

    await store.save(state);

    expect(await store.load(state.runId)).toEqual(state);
  });

  it('loads a run saved before slices recorded the commit they started from', async () => {
    const { store, repoRoot } = await setup();
    const { startCommit: _, ...savedBeforeStartCommits } = aSlice({ status: 'in_review' });
    const state = aRunState({ phase: 'slices', slices: [savedBeforeStartCommits] });
    await mkdir(stateDirectory(repoRoot, state.runId), { recursive: true });
    await writeFile(
      path.join(stateDirectory(repoRoot, state.runId), 'run.json'),
      JSON.stringify(state),
    );

    const loaded = await store.load(state.runId);

    expect(loaded?.slices[0].id).toBe(savedBeforeStartCommits.id);
    expect(loaded?.slices[0].startCommit).toBeUndefined();
  });

  it('knows nothing about a run it never saved', async () => {
    const { store } = await setup();

    expect(await store.load(aRunState().runId)).toBeUndefined();
  });

  it('writes the design, plan and pull request description beside the state for a person to read', async () => {
    const { store, repoRoot } = await setup();
    const docs = designDocs();
    const prDescription = faker.lorem.paragraphs();
    const state = aRunState({ docs, prDescription });

    await store.save(state);

    const directory = stateDirectory(repoRoot, state.runId);
    expect(await readFile(path.join(directory, 'design.md'), 'utf-8')).toBe(docs.design);
    expect(await readFile(path.join(directory, 'plan.md'), 'utf-8')).toBe(docs.plan);
    expect(await readFile(path.join(directory, 'PR_DESCRIPTION.md'), 'utf-8')).toBe(prDescription);
    expect(store.documentPath(state.runId, 'design.md')).toBe(path.join(directory, 'design.md'));
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

  it('summarises how a run ended for CI, naming a stuck slice', async () => {
    const { store, repoRoot } = await setup();
    const stuck = aSlice({ status: 'stuck' });
    const state = aRunState({ phase: 'stuck', slices: [stuck] });

    await store.writeResult(state, 'stuck');

    const result = JSON.parse(
      await readFile(path.join(stateDirectory(repoRoot, state.runId), 'result.json'), 'utf-8'),
    );
    expect(result).toEqual({
      runId: state.runId,
      status: 'stuck',
      phase: 'stuck',
      complete: false,
      blockedReason: `slice "${stuck.id}" is stuck — needs human intervention`,
    });
  });

  async function setup() {
    const repoRoot = await mkdtemp(path.join(tmpdir(), 'sdlc-store-'));
    directories.push(repoRoot);
    return { store: new LocalRunStore(repoRoot), repoRoot };
  }
});
