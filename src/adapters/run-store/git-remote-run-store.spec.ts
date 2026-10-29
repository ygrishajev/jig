import { faker } from '@faker-js/faker';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { afterEach, describe, expect, it } from 'vitest';
import { RunStateConflict } from '../../domain/errors.js';
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
    expect(await refsUnder(origin, 'refs/sdlc')).toEqual([`refs/sdlc/${state.runId}`]);
    expect(await refsUnder(origin, 'refs/heads')).not.toContain(`refs/heads/sdlc/${state.runId}`);
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

  it('catches a stale run branch up with the remote, even when a worktree has it checked out', async () => {
    const { origin, cloneOf, checkOutInWorktree } = await setup();
    const here = await cloneOf();
    const state = aRunState({ phase: 'slices' });
    await commitOnRunBranch(here, state.runId);
    await new GitRemoteRunStore(here).save(state);
    const worktree = await checkOutInWorktree(here, runBranchFor(state.runId));
    const elsewhere = await cloneOf();
    const elsewhereStore = new GitRemoteRunStore(elsewhere);
    await elsewhereStore.load(state.runId);
    const advancedHead = await commitOnRunBranch(elsewhere, state.runId);
    const advanced = { ...state, plan: aFeaturePlan() };
    await elsewhereStore.save(advanced);

    const store = new GitRemoteRunStore(here);
    expect(await store.load(state.runId)).toEqual(advanced);
    await store.save({ ...advanced, phase: 'describing' });

    expect(await simpleGit({ baseDir: worktree }).revparse(['HEAD'])).toBe(advancedHead);
    expect(await simpleGit({ baseDir: origin }).revparse([runBranchFor(state.runId)])).toBe(
      advancedHead,
    );
  });

  it('refuses to save over a run that another clone pushed since this one loaded it', async () => {
    const { cloneOf } = await setup();
    const here = await cloneOf();
    const store = new GitRemoteRunStore(here);
    const state = aRunState({ phase: 'planning' });
    await store.save(state);
    const elsewhere = new GitRemoteRunStore(await cloneOf());
    await elsewhere.load(state.runId);
    const theirs = { ...state, phase: 'designing' as const, plan: aFeaturePlan() };
    await elsewhere.save(theirs);

    await expect(store.save({ ...state, phase: 'designing' })).rejects.toBeInstanceOf(
      RunStateConflict,
    );
    expect(await new GitRemoteRunStore(await cloneOf()).load(state.runId)).toEqual(theirs);
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
    const checkOutInWorktree = async (repo: string, branch: string) => {
      const directory = await mkdtemp(path.join(tmpdir(), 'sdlc-worktree-'));
      cleanups.push(() => rm(directory, { recursive: true, force: true }));
      await simpleGit({ baseDir: repo }).raw(['worktree', 'add', directory, branch]);
      return directory;
    };
    return { origin, cloneOf, checkOutInWorktree };
  }
});

async function refsUnder(repo: string, prefix: string) {
  const refs = await simpleGit({ baseDir: repo }).raw([
    'for-each-ref',
    '--format=%(refname)',
    prefix,
  ]);
  return refs.trim().split('\n').filter(Boolean);
}

async function commitOnRunBranch(repo: string, runId: string) {
  const git = simpleGit({ baseDir: repo });
  const branch = runBranchFor(runId);
  const existing = await git.branchLocal();
  if (existing.all.includes(branch)) await git.checkout(branch);
  else await git.checkoutLocalBranch(branch);
  await writeFile(path.join(repo, `${faker.word.noun()}.txt`), faker.lorem.sentence());
  await git.add('-A');
  await git.commit(faker.lorem.sentence());
  const head = await git.revparse(['HEAD']);
  await git.checkout('main');
  return head;
}
