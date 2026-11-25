import { faker } from '@faker-js/faker';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { aJigConfig, aRunState } from '../../tests/support/builders.js';
import { createRemote } from '../../tests/support/temp-repo.js';
import { unwrap } from '../../tests/support/unwrap.js';
import { LocalRunStore } from '../adapters/local-store/local-run-store.js';
import { GitRemoteRunStore } from '../adapters/run-store/git-remote-run-store.js';
import { RepositoryRunStores } from '../adapters/run-store/repository-run-stores.js';
import { runBranchFor } from '../domain/run-state.js';
import { openRunStore } from './run-stores.js';

describe('openRunStore', () => {
  it('adds required stores once while keeping configured stores', async () => {
    const { repoRoot, config, state } = await setup();
    const store = unwrap(
      await openRunStore(new RepositoryRunStores(repoRoot), config, [
        'git-remote',
        'local',
        'git-remote',
      ]),
    );
    unwrap(await store.save(state));
    const local = unwrap(await new LocalRunStore(repoRoot).load(state.runId));
    const remote = unwrap(await new GitRemoteRunStore(repoRoot).load(state.runId));
    expect(local).toEqual(remote);
    expect(local?.revision).toBe(state.revision + 1);
  });

  it('resumes an interrupted deferred run from the code checkpoint this clone kept', async () => {
    const { repoRoot, config, deferred } = await setup();
    const branch = runBranchFor(deferred.runId);
    const checkpoint = await commitOn(repoRoot, branch);
    unwrap(
      await unwrap(
        await openRunStore(new RepositoryRunStores(repoRoot), config, ['git-remote']),
      ).save(deferred),
    );
    await simpleGit(repoRoot).branch(['-D', branch]);

    const resumed = unwrap(
      await unwrap(
        await openRunStore(new RepositoryRunStores(repoRoot), config, ['git-remote']),
      ).load(deferred.runId),
    );

    expect(resumed?.codeRevision).toBe(checkpoint);
    expect(await simpleGit(repoRoot).revparse([branch])).toBe(checkpoint);
    expect(await simpleGit(repoRoot).listRemote(['origin', `refs/heads/${branch}`])).toBe('');
  });

  it('refuses to resume a deferred run on a clone without its unpublished code', async () => {
    const { repoRoot, config, deferred, cloneOf } = await setup();
    await commitOn(repoRoot, runBranchFor(deferred.runId));
    unwrap(
      await unwrap(
        await openRunStore(new RepositoryRunStores(repoRoot), config, ['git-remote']),
      ).save(deferred),
    );
    const elsewhere = await cloneOf();

    const loaded = await unwrap(
      await openRunStore(new RepositoryRunStores(elsewhere), config, ['git-remote']),
    ).load(deferred.runId);

    expect(loaded.isErr() && loaded.error._tag).toBe('RunCodeUnavailable');
  });

  it('resumes a deferred run on another clone once its checkpoint was published', async () => {
    const { repoRoot, config, deferred, cloneOf } = await setup();
    const branch = runBranchFor(deferred.runId);
    const checkpoint = await commitOn(repoRoot, branch);
    unwrap(
      await unwrap(
        await openRunStore(new RepositoryRunStores(repoRoot), config, ['git-remote']),
      ).save(deferred),
    );
    await simpleGit(repoRoot).push(['origin', `${checkpoint}:refs/heads/${branch}`]);
    const elsewhere = await cloneOf();

    const resumed = unwrap(
      await unwrap(
        await openRunStore(new RepositoryRunStores(elsewhere), config, ['git-remote']),
      ).load(deferred.runId),
    );

    expect(resumed?.codeRevision).toBe(checkpoint);
    expect(await simpleGit(elsewhere).revparse([branch])).toBe(checkpoint);
  });

  async function commitOn(repo: string, branch: string) {
    const git = simpleGit(repo);
    await git.checkout(['-b', branch]);
    await writeFile(path.join(repo, `${faker.string.alpha(10)}.txt`), faker.lorem.paragraph());
    await git.add('.');
    await git.commit(faker.git.commitMessage());
    const head = await git.revparse(['HEAD']);
    await git.checkout('main');
    return head;
  }

  async function setup() {
    const { cloneOf } = await createRemote();
    const repoRoot = await cloneOf();
    return {
      repoRoot,
      cloneOf,
      config: aJigConfig(),
      state: aRunState(),
      deferred: aRunState({ codePublication: 'deferred' }),
    };
  }
});
