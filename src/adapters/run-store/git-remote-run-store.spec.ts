import { faker } from '@faker-js/faker';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { runBranchFor } from '../../domain/run-state.js';
import { aFeaturePlan, aRunState, aSlice } from '../../../tests/support/builders.js';
import { createTempRepo } from '../../../tests/support/temp-repo.js';
import { GitRemoteRunStore } from './git-remote-run-store.js';

describe('GitRemoteRunStore', () => {
  const cleanups: (() => Promise<void>)[] = [];

  afterEach(async () => {
    await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  });

  it('lets another clone pick up a run saved on this one, with its branch', async () => {
    const { origin, cloneOf } = await setup();
    const here = await cloneOf();
    const state = aRunState({
      phase: 'slices',
      plan: aFeaturePlan(),
      slices: [aSlice({ status: 'in_review' })],
    });
    const branchHead = await commitOnRunBranch(here, state.runId);

    await new GitRemoteRunStore(here).save(state);

    const elsewhere = await cloneOf();
    expect(await new GitRemoteRunStore(elsewhere).load(state.runId)).toEqual(state);
    expect(await simpleGit({ baseDir: elsewhere }).revparse([runBranchFor(state.runId)])).toBe(
      branchHead,
    );
    expect(await simpleGit({ baseDir: origin }).branchLocal()).not.toHaveProperty([
      'branches',
      `refs/sdlc/${state.runId}`,
    ]);
  });

  it('keeps every save as history and loads the latest', async () => {
    const { cloneOf } = await setup();
    const here = await cloneOf();
    const store = new GitRemoteRunStore(here);
    const first = aRunState({ phase: 'planning' });
    const latest = { ...first, phase: 'designing' as const, plan: aFeaturePlan() };

    await store.save(first);
    await store.save(latest);

    expect(await new GitRemoteRunStore(await cloneOf()).load(first.runId)).toEqual(latest);
    const history = await simpleGit({ baseDir: here }).raw([
      'log',
      '--format=%s',
      `refs/sdlc/${first.runId}`,
    ]);
    expect(history.trim().split('\n')).toEqual([
      `sdlc run ${first.runId}: designing`,
      `sdlc run ${first.runId}: planning`,
    ]);
  });

  it('knows nothing about a run that was never pushed', async () => {
    const { cloneOf } = await setup();

    expect(await new GitRemoteRunStore(await cloneOf()).load(aRunState().runId)).toBeUndefined();
  });

  async function setup() {
    const seed = await createTempRepo();
    const origin = await mkdtemp(path.join(tmpdir(), 'sdlc-origin-'));
    cleanups.push(seed.cleanup, () => rm(origin, { recursive: true, force: true }));
    await simpleGit().clone(seed.dir, origin, ['--bare']);
    const cloneOf = async () => {
      const directory = await mkdtemp(path.join(tmpdir(), 'sdlc-clone-'));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      await simpleGit().clone(origin, directory);
      const git = simpleGit({ baseDir: directory });
      await git.addConfig('user.email', 'test@example.com');
      await git.addConfig('user.name', 'Test');
      await git.addConfig('commit.gpgsign', 'false');
      return directory;
    };
    return { origin, cloneOf };
  }
});

async function commitOnRunBranch(repo: string, runId: string) {
  const git = simpleGit({ baseDir: repo });
  await git.checkoutLocalBranch(runBranchFor(runId));
  await writeFile(path.join(repo, `${faker.word.noun()}.txt`), faker.lorem.sentence());
  await git.add('-A');
  await git.commit(faker.lorem.sentence());
  const head = await git.revparse(['HEAD']);
  await git.checkout('main');
  return head;
}
