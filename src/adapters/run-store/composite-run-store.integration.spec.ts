import { faker } from '@faker-js/faker';
import { panic } from 'better-result';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { aRunState } from '../../../tests/support/builders.js';
import { tempDirectory } from '../../../tests/support/temp-directory.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { runBranchFor } from '../../domain/run-state.js';
import { RunCodeUnavailable } from '../../ports/run-state-failures.js';
import { GitRunCode } from '../git/run-code.js';
import { LocalRunStore } from '../local-store/local-run-store.js';
import { CompositeRunStore } from './composite-run-store.js';
import { GitRemoteRunStore } from './git-remote-run-store.js';

describe('CompositeRunStore on real git', () => {
  it('recovers an initial legacy checkpoint from persisted state without using the advanced default', async () => {
    const { cloneOf } = await createRemote();
    const here = await cloneOf();
    const git = simpleGit(here);
    const startingCommit = await git.revparse(['HEAD']);
    const state = aRunState({ startingCommit, codePublication: 'deferred' });
    unwrap(await new GitRemoteRunStore(here).save(state));
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    await git.push('origin', 'main');
    const store = new CompositeRunStore([new GitRemoteRunStore(here)], new GitRunCode(here));

    expect(unwrap(await store.load(state.runId))).toEqual({
      ...state,
      codeRevision: startingCommit,
    });
    expect(await git.revparse([runBranchFor(state.runId)])).toBe(startingCommit);
    expect(await git.listRemote(['origin', `refs/heads/${runBranchFor(state.runId)}`])).toBe('');
  });

  it('restores the original start after main advances and later restores unpublished run work', async () => {
    const { origin, cloneOf } = await createRemote();
    const here = await cloneOf();
    const git = simpleGit(here);
    const startingCommit = await git.revparse(['HEAD']);
    const state = aRunState({ codePublication: 'deferred', startingCommit });
    const branch = runBranchFor(state.runId);
    const freshStore = (repo: string) =>
      new CompositeRunStore(
        [new LocalRunStore(repo), new GitRemoteRunStore(repo)],
        new GitRunCode(repo),
      );
    unwrap(await freshStore(here).save(state));
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    await git.push('origin', 'main');

    const restored = unwrap(await freshStore(here).load(state.runId));
    expect(restored).toMatchObject({ startingCommit, codeRevision: startingCommit });
    expect(await git.revparse([branch])).toBe(startingCommit);
    const worktree = await tempDirectory('jig-resume-');
    await git.raw(['worktree', 'add', worktree, branch]);
    expect(await simpleGit(worktree).revparse(['HEAD'])).toBe(startingCommit);
    await writeFile(path.join(worktree, 'run.txt'), faker.lorem.paragraph());
    await simpleGit(worktree).add('run.txt');
    await simpleGit(worktree).commit(faker.git.commitMessage());
    const codeRevision = await simpleGit(worktree).revparse(['HEAD']);
    const store = freshStore(here);
    const loaded = unwrap(await store.load(state.runId));
    if (!loaded) panic('The initial checkpoint was not restored');
    unwrap(await store.save(loaded));
    await git.raw(['worktree', 'remove', worktree]);
    await git.branch(['-D', branch]);

    const resumed = unwrap(await freshStore(here).load(state.runId));
    expect(resumed).toMatchObject({ startingCommit, codeRevision });
    expect(await git.revparse([branch])).toBe(codeRevision);
    expect(await git.listRemote(['origin', `refs/heads/${branch}`])).toBe('');
    const stateHistory = await git.raw(['rev-list', `refs/jig/${state.runId}`]);
    expect(stateHistory.split('\n')).not.toContain(startingCommit);
    expect(stateHistory.split('\n')).not.toContain(codeRevision);
    const elsewhere = await cloneOf();
    await simpleGit(elsewhere).fetch(['origin', `+refs/jig/*:refs/jig/*`]);
    for (const repo of [origin, elsewhere]) {
      expect(
        await simpleGit(repo)
          .raw(['cat-file', '-t', codeRevision])
          .then(
            () => true,
            () => false,
          ),
      ).toBe(false);
    }
    const unavailable = await freshStore(elsewhere).load(state.runId);
    expect(unavailable.isErr() && unavailable.error).toBeInstanceOf(RunCodeUnavailable);
  });
});
