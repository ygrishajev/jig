import { faker } from '@faker-js/faker';
import { panic } from 'better-result';
import { mkdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { simpleGit } from 'simple-git';
import { describe, expect, it } from 'vitest';

import { aRunState, runId } from '../../../tests/support/builders.js';
import { createRemote } from '../../../tests/support/temp-repo.js';
import { unwrap } from '../../../tests/support/unwrap.js';
import { GitRunCode } from '../../adapters/git/run-code.js';
import { CompositeRunStore } from '../../adapters/run-store/composite-run-store.js';
import { GitRemoteRunStore } from '../../adapters/run-store/git-remote-run-store.js';
import { runBranchFor } from '../../domain/run-state.js';
import { hasWorkBeyondStart, publishRunBranch } from './run-branch-publication.js';

describe('publishRunBranch', () => {
  it('pushes exactly the inspected commit when no workflow changes', async () => {
    const { publish, commitOnRunBranch, remoteBranch } = await setup();
    const revision = await commitOnRunBranch({ write: { [allowedPath()]: faker.lorem.word() } });

    expect(unwrap(await publish(revision))).toEqual({ kind: 'published', changesFiles: true });
    expect(await remoteBranch()).toBe(revision);
  });

  const existing = '.github/workflows/existing.yml';
  const added = `.github/workflows/${workflowName()}`;
  const renamedIn = `.github/workflows/${workflowName()}`;
  it.each<[string, Change, string[]]>([
    ['adds', { write: { [added]: 'on: push' } }, [added]],
    ['modifies', { write: { [existing]: 'on: [push, pull_request]' } }, [existing]],
    ['deletes', { remove: [existing] }, [existing]],
    ['retypes', { link: { [existing]: '../../README.md' } }, [existing]],
    ['renames out of', { move: { [existing]: 'disabled.yml' } }, [existing]],
    ['renames into', { move: { 'kept.yml': renamedIn } }, [renamedIn]],
  ])(
    'refuses a revision that %s a workflow, naming it and pushing nothing',
    async (_, change, paths) => {
      const { publish, commitOnRunBranch, remoteBranch, seedDefault } = await setup();
      await seedDefault({ write: { [existing]: 'on: push', 'kept.yml': faker.lorem.word() } });
      const revision = await commitOnRunBranch(change);

      const published = unwrap(await publish(revision));

      expect(published).toEqual({ kind: 'refused', paths });
      expect(await remoteBranch()).toBeUndefined();
    },
  );

  it('names every workflow a refused revision changes, and only those', async () => {
    const { publish, commitOnRunBranch } = await setup();
    const workflows = faker.helpers
      .uniqueArray(workflowName, 3)
      .map((name) => `.github/workflows/${name}`);
    const revision = await commitOnRunBranch({
      write: Object.fromEntries(
        [...workflows, allowedPath()].map((file) => [file, faker.lorem.word()]),
      ),
    });

    const published = unwrap(await publish(revision));

    expect(published.kind === 'refused' && [...published.paths].sort()).toEqual(
      [...workflows].sort(),
    );
  });

  it.each([
    '.github/workflows-old/ci.yml',
    '.github/workflow/ci.yml',
    '.github/workflowsci.yml',
    'docs/.github/workflows/ci.yml',
    '.github/actions/setup/action.yml',
    '.GitHub/Workflows/ci.yml',
  ])('publishes a similarly named path that is not a workflow: %s', async (file) => {
    const { publish, commitOnRunBranch, remoteBranch } = await setup();
    const revision = await commitOnRunBranch({ write: { [file]: faker.lorem.word() } });

    expect(unwrap(await publish(revision))).toEqual({ kind: 'published', changesFiles: true });
    expect(await remoteBranch()).toBe(revision);
  });

  it('inspects only what the run changed when the default branch changed a workflow since', async () => {
    const { publish, commitOnRunBranch, seedDefault, remoteBranch } = await setup();
    const revision = await commitOnRunBranch({ write: { [allowedPath()]: faker.lorem.word() } });
    await seedDefault({ write: { [`.github/workflows/${workflowName()}`]: 'on: push' } });

    expect(unwrap(await publish(revision))).toEqual({ kind: 'published', changesFiles: true });
    expect(await remoteBranch()).toBe(revision);
  });

  it('skips a revision that changes nothing against the default branch', async () => {
    const { publish, here, remoteBranch, id } = await setup();
    const head = await simpleGit(here).revparse(['HEAD']);
    await simpleGit(here).branch([runBranchFor(id), head]);

    expect(unwrap(await publish(head))).toEqual({ kind: 'unchanged' });
    expect(await remoteBranch()).toBeUndefined();
  });

  it('skips an empty commit, which still counts as work beyond the starting commit', async () => {
    const { publish, here, remoteBranch, id } = await setup();
    const git = simpleGit(here);
    const startingCommit = await git.revparse(['HEAD']);
    await git.checkout(['-b', runBranchFor(id)]);
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    const codeRevision = await git.revparse(['HEAD']);
    await git.checkout('main');

    expect(unwrap(await publish(codeRevision))).toEqual({ kind: 'unchanged' });
    expect(await remoteBranch()).toBeUndefined();
    expect(unwrap(await hasWorkBeyondStart(here, { startingCommit, codeRevision }))).toBe(true);
  });

  it('pushes commits that change nothing when asked to, reporting that they change no files', async () => {
    const { publish, here, remoteBranch, id } = await setup();
    const git = simpleGit(here);
    await git.checkout(['-b', runBranchFor(id)]);
    await git.commit(faker.git.commitMessage(), ['--allow-empty']);
    const codeRevision = await git.revparse(['HEAD']);
    await git.checkout('main');

    expect(unwrap(await publish(codeRevision, { pushUnchanged: true }))).toEqual({
      kind: 'published',
      changesFiles: false,
    });
    expect(await remoteBranch()).toBe(codeRevision);
  });

  it('still refuses a workflow change when asked to push unchanged commits', async () => {
    const { publish, commitOnRunBranch, remoteBranch } = await setup();
    const workflow = `.github/workflows/${workflowName()}`;
    const revision = await commitOnRunBranch({ write: { [workflow]: 'on: push' } });

    expect(unwrap(await publish(revision, { pushUnchanged: true }))).toEqual({
      kind: 'refused',
      paths: [workflow],
    });
    expect(await remoteBranch()).toBeUndefined();
  });

  it('refuses a run branch that moved past the inspected revision', async () => {
    const { publish, commitOnRunBranch, remoteBranch } = await setup();
    const revision = await commitOnRunBranch({ write: { [allowedPath()]: faker.lorem.word() } });
    await commitOnRunBranch({ write: { [allowedPath()]: faker.lorem.word() } });

    const published = await publish(revision);

    expect(published.isErr() && published.error._tag).toBe('RunBranchUnpublishable');
    expect(await remoteBranch()).toBeUndefined();
  });

  it('keeps an earlier publication and fast-forwards it to the next approved revision', async () => {
    const { publish, commitOnRunBranch, remoteBranch } = await setup();
    const first = await commitOnRunBranch({ write: { [allowedPath()]: faker.lorem.word() } });
    unwrap(await publish(first));
    const next = await commitOnRunBranch({ write: { [allowedPath()]: faker.lorem.word() } });

    expect(unwrap(await publish(next))).toEqual({ kind: 'published', changesFiles: true });
    expect(unwrap(await publish(next))).toEqual({ kind: 'published', changesFiles: true });
    expect(await remoteBranch()).toBe(next);
  });

  it('refuses to replace a remote run branch someone else moved', async () => {
    const { publish, commitOnRunBranch, remoteBranch, cloneOf, id } = await setup();
    const revision = await commitOnRunBranch({ write: { [allowedPath()]: faker.lorem.word() } });
    const elsewhere = await cloneOf();
    const git = simpleGit(elsewhere);
    await git.checkout(['-b', runBranchFor(id)]);
    await writeFile(path.join(elsewhere, allowedPath()), faker.lorem.word());
    await git.add('.');
    await git.commit(faker.git.commitMessage());
    await git.push(['origin', runBranchFor(id)]);
    const theirs = await git.revparse(['HEAD']);

    const published = await publish(revision);

    expect(published.isErr() && published.error._tag).toBe('RunBranchUnpublishable');
    expect(await remoteBranch()).toBe(theirs);
  });

  it('publishes nothing when the default branch cannot be inspected', async () => {
    const { here, commitOnRunBranch, id, remoteBranch } = await setup();
    const revision = await commitOnRunBranch({ write: { [allowedPath()]: faker.lorem.word() } });

    const published = await publishRunBranch(here, {
      runId: id,
      revision,
      defaultBranch: faker.string.alpha(12),
    });

    expect(published.isErr() && published.error._tag).toBe('RunBranchUnpublishable');
    expect(await remoteBranch()).toBeUndefined();
  });

  describe('hasWorkBeyondStart', () => {
    it('counts only run commits from a checkpoint restored after the default branch advances', async () => {
      const { cloneOf } = await createRemote();
      const here = await cloneOf();
      const git = simpleGit(here);
      const startingCommit = await git.revparse(['HEAD']);
      const state = aRunState({ startingCommit, codePublication: 'deferred' });
      const freshStore = () =>
        new CompositeRunStore([new GitRemoteRunStore(here)], new GitRunCode(here));
      unwrap(await freshStore().save(state));
      await git.commit(faker.git.commitMessage(), ['--allow-empty']);
      await git.push('origin', 'main');
      const store = freshStore();
      const restored = unwrap(await store.load(state.runId));
      if (!restored) panic('The initial checkpoint was not restored');
      expect(unwrap(await hasWorkBeyondStart(here, restored))).toBe(false);
      await git.checkout(runBranchFor(state.runId));
      await git.commit(faker.git.commitMessage(), ['--allow-empty']);
      unwrap(await store.save(restored));
      const resumed = unwrap(await freshStore().load(state.runId));
      if (!resumed) panic('The run checkpoint was not restored');
      expect(unwrap(await hasWorkBeyondStart(here, resumed))).toBe(true);
    });

    it('counts commits made past the recorded starting commit', async () => {
      const { here, commitOnRunBranch } = await setup();
      const startingCommit = await simpleGit(here).revparse(['HEAD']);
      const codeRevision = await commitOnRunBranch({
        write: { [allowedPath()]: faker.lorem.word() },
      });

      expect(unwrap(await hasWorkBeyondStart(here, { startingCommit, codeRevision }))).toBe(true);
      expect(
        unwrap(await hasWorkBeyondStart(here, { startingCommit, codeRevision: startingCommit })),
      ).toBe(false);
    });

    it('never takes a run without a recorded starting commit to have work', async () => {
      const { here, commitOnRunBranch } = await setup();
      const codeRevision = await commitOnRunBranch({
        write: { [allowedPath()]: faker.lorem.word() },
      });

      expect(unwrap(await hasWorkBeyondStart(here, { codeRevision }))).toBe(false);
    });
  });

  function allowedPath() {
    return `${faker.string.alpha(10)}.txt`;
  }

  function workflowName() {
    return `${faker.string.alpha(10)}.yml`;
  }

  async function setup() {
    const { cloneOf, origin } = await createRemote();
    const here = await cloneOf();
    const id = runId();
    const branch = runBranchFor(id);
    const git = simpleGit(here);
    const applyAndCommit = async (change: Change) => {
      await applyChange(here, change);
      await git.raw(['add', '-A']);
      await git.commit(faker.git.commitMessage());
      return git.revparse(['HEAD']);
    };
    const seedDefault = async (change: Change) => {
      const head = await applyAndCommit(change);
      await git.push(['origin', 'main']);
      return head;
    };
    const commitOnRunBranch = async (change: Change) => {
      const exists = (await git.branchLocal()).all.includes(branch);
      await git.checkout(exists ? [branch] : ['-b', branch]);
      const head = await applyAndCommit(change);
      await git.checkout('main');
      return head;
    };
    const remoteBranch = async () => {
      const listed = await simpleGit(origin).raw([
        'for-each-ref',
        '--format=%(objectname)',
        `refs/heads/${branch}`,
      ]);
      return listed.trim() || undefined;
    };
    const publish = (revision: string, options: { pushUnchanged?: boolean } = {}) =>
      publishRunBranch(here, { runId: id, revision, defaultBranch: 'main', ...options });
    return { here, id, cloneOf, publish, commitOnRunBranch, seedDefault, remoteBranch };
  }
});

interface Change {
  write?: Record<string, string>;
  remove?: string[];
  link?: Record<string, string>;
  move?: Record<string, string>;
}

async function applyChange(repo: string, change: Change) {
  for (const [file, contents] of Object.entries(change.write ?? {})) {
    await mkdir(path.dirname(path.join(repo, file)), { recursive: true });
    await writeFile(path.join(repo, file), contents);
  }
  for (const file of change.remove ?? []) await rm(path.join(repo, file));
  for (const [file, target] of Object.entries(change.link ?? {})) {
    await rm(path.join(repo, file));
    await symlink(target, path.join(repo, file));
  }
  for (const [from, to] of Object.entries(change.move ?? {})) {
    await mkdir(path.dirname(path.join(repo, to)), { recursive: true });
    await rename(path.join(repo, from), path.join(repo, to));
  }
}
