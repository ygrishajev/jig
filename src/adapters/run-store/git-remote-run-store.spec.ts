import { faker } from '@faker-js/faker';
import { rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import {
  aFeaturePlan,
  aRevisedDesignReview,
  aRunState,
  aSlice,
} from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { GitCommandFailed, RemoteUnavailable, RunStateConflict } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import { GitRemoteRunStore } from './git-remote-run-store.js';

describe('GitRemoteRunStore', () => {
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
    expect((await new GitRemoteRunStore(elsewhere).load(state.runId)).unwrap()).toEqual(state);
    expect(await simpleGit({ baseDir: elsewhere }).revparse([runBranchFor(state.runId)])).toBe(
      branchHead,
    );
    expect(await refsUnder(origin, 'refs/jig')).toEqual([`refs/jig/${state.runId}`]);
    expect(await refsUnder(origin, 'refs/heads')).not.toContain(`refs/heads/jig/${state.runId}`);
  });

  it('lets another clone pick up the design review evidence a blocked run left', async () => {
    const { cloneOf } = await setup();
    const state = aRunState({
      phase: 'resolvingDesign',
      designReview: aRevisedDesignReview(),
      blockedReason: faker.lorem.sentence(),
    });

    await new GitRemoteRunStore(await cloneOf()).save(state);

    expect((await new GitRemoteRunStore(await cloneOf()).load(state.runId)).unwrap()).toEqual(
      state,
    );
  });

  it('keeps every save as history and loads the latest', async () => {
    const { cloneOf } = await setup();
    const here = await cloneOf();
    const store = new GitRemoteRunStore(here);
    const first = aRunState({ phase: 'planning' });
    const latest = aRunState({ ...first, phase: 'designing', plan: aFeaturePlan() });

    await store.save(first);
    await store.save(latest);

    expect((await new GitRemoteRunStore(await cloneOf()).load(first.runId)).unwrap()).toEqual(
      latest,
    );
    const history = await simpleGit({ baseDir: here }).raw([
      'log',
      '--format=%s',
      `refs/jig/${first.runId}`,
    ]);
    expect(history.trim().split('\n')).toEqual([
      `jig run ${first.runId}: designing`,
      `jig run ${first.runId}: planning`,
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
    expect((await store.load(state.runId)).unwrap()).toEqual(advanced);
    await store.save(aRunState({ ...advanced, phase: 'describing' }));

    expect(await simpleGit({ baseDir: worktree }).revparse(['HEAD'])).toBe(advancedHead);
    expect(await simpleGit({ baseDir: origin }).revparse([runBranchFor(state.runId)])).toBe(
      advancedHead,
    );
  });

  it('catches a stale run branch up with the remote when no worktree has it checked out', async () => {
    const { cloneOf } = await setup();
    const here = await cloneOf();
    const state = aRunState({ phase: 'slices' });
    await commitOnRunBranch(here, state.runId);
    await new GitRemoteRunStore(here).save(state);
    const elsewhere = await cloneOf();
    const elsewhereStore = new GitRemoteRunStore(elsewhere);
    await elsewhereStore.load(state.runId);
    const advancedHead = await commitOnRunBranch(elsewhere, state.runId);
    await elsewhereStore.save(state);

    await new GitRemoteRunStore(here).load(state.runId);

    expect(await simpleGit({ baseDir: here }).revparse([runBranchFor(state.runId)])).toBe(
      advancedHead,
    );
  });

  it('keeps a local run branch that is ahead of the remote with commits not pushed yet', async () => {
    const { cloneOf } = await setup();
    const here = await cloneOf();
    const state = aRunState({ phase: 'slices' });
    await commitOnRunBranch(here, state.runId);
    await new GitRemoteRunStore(here).save(state);
    const aheadHead = await commitOnRunBranch(here, state.runId);

    await new GitRemoteRunStore(here).load(state.runId);

    expect(await simpleGit({ baseDir: here }).revparse([runBranchFor(state.runId)])).toBe(
      aheadHead,
    );
  });

  it('refuses a run whose branch here and on the remote have diverged', async () => {
    const { cloneOf } = await setup();
    const here = await cloneOf();
    const state = aRunState({ phase: 'slices' });
    await commitOnRunBranch(here, state.runId);
    await new GitRemoteRunStore(here).save(state);
    const elsewhere = await cloneOf();
    const elsewhereStore = new GitRemoteRunStore(elsewhere);
    await elsewhereStore.load(state.runId);
    await commitOnRunBranch(elsewhere, state.runId);
    await elsewhereStore.save(state);
    await commitOnRunBranch(here, state.runId);

    const loaded = await new GitRemoteRunStore(here).load(state.runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(RunStateConflict);
  });

  it('reports an ancestry failure after fetching the remote state and branch', async () => {
    const { cloneOf } = await setup();
    const here = await cloneOf();
    const state = aRunState({ phase: 'slices' });
    const remoteHead = await commitOnRunBranch(here, state.runId);
    unwrap(await new GitRemoteRunStore(here).save(state));
    const localHead = await commitOnRunBranch(here, state.runId);
    const git = simpleGit({ baseDir: here });
    const blob = (await git.raw(['hash-object', '-w', 'README.md'])).trim();
    await git.raw(['replace', '--force', localHead, blob]);

    const loaded = await new GitRemoteRunStore(here).load(state.runId);

    expect(loaded.isErr()).toBe(true);
    expect(loaded.isErr() && loaded.error).toBeInstanceOf(GitCommandFailed);
    expect(loaded.isErr() && loaded.error).toMatchObject({
      command: `git merge-base --is-ancestor ${remoteHead} ${localHead}`,
      output: expect.stringContaining('error'),
    });
    expect(await git.revparse([`refs/remotes/origin/${runBranchFor(state.runId)}`])).toBe(
      remoteHead,
    );
    expect(JSON.parse(await git.show([`refs/jig/${state.runId}:run.json`]))).toEqual(state);
    expect(await git.revparse([runBranchFor(state.runId)])).toBe(localHead);
  });

  it('retries an unreachable remote, then reports it unavailable', async () => {
    const { cloneOf, origin } = await setup();
    const here = await cloneOf();
    await rm(origin, { recursive: true, force: true });

    const loaded = await new GitRemoteRunStore(here).load(aRunState().runId);

    expect(loaded.isErr() && loaded.error).toBeInstanceOf(RemoteUnavailable);
  });

  it('blocks rather than retries when the remote copy moved', async () => {
    const { cloneOf } = await setup();
    const here = await cloneOf();
    const store = new GitRemoteRunStore(here);
    const state = aRunState({ phase: 'planning' });
    await store.save(state);
    const elsewhere = new GitRemoteRunStore(await cloneOf());
    await elsewhere.load(state.runId);
    const theirs = aRunState({ ...state, phase: 'designing', plan: aFeaturePlan() });
    await elsewhere.save(theirs);

    const saved = await store.save(aRunState({ ...state, phase: 'designing' }));

    expect(saved.isErr() && saved.error).toBeInstanceOf(RunStateConflict);
    expect(
      (await new GitRemoteRunStore(await cloneOf()).load(state.runId)).unwrapOr(undefined),
    ).toEqual(theirs);
  });

  it('pushes only the state of a run that defers its code, leaving the code unreachable', async () => {
    const { origin, cloneOf } = await setup();
    const here = await cloneOf();
    const id = aRunState().runId;
    const codeRevision = await commitOnRunBranch(here, id);
    const state = aRunState({
      runId: id,
      phase: 'slices',
      codePublication: 'deferred',
      codeRevision,
    });

    const store = new GitRemoteRunStore(here);
    unwrap(await store.save(state));
    unwrap(await store.save(aRunState({ ...state, phase: 'describing' })));

    expect(await refsUnder(origin, 'refs/heads')).not.toContain(`refs/heads/${runBranchFor(id)}`);
    expect(await objectExists(origin, codeRevision)).toBe(false);
    const elsewhere = await cloneOf();
    await simpleGit({ baseDir: elsewhere }).fetch(['origin', `+refs/jig/*:refs/jig/*`]);
    expect(await objectExists(elsewhere, codeRevision)).toBe(false);
    expect(unwrap(await new GitRemoteRunStore(elsewhere).load(id))).toMatchObject({
      phase: 'describing',
      codeRevision,
    });
  });

  it('knows nothing about a run that was never pushed', async () => {
    const { cloneOf } = await setup();

    const loaded = await new GitRemoteRunStore(await cloneOf()).load(aRunState().runId);

    expect(loaded.unwrap()).toBeUndefined();
  });

  async function setup() {
    const { origin, cloneOf } = await createRemote();
    const checkOutInWorktree = async (repo: string, branch: string) => {
      const directory = await tempDirectory('jig-worktree-');
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

async function commitOnRunBranch(repo: string, runId: RunId) {
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

async function objectExists(repo: string, object: string) {
  return simpleGit({ baseDir: repo })
    .raw(['cat-file', '-t', object])
    .then(
      () => true,
      () => false,
    );
}
