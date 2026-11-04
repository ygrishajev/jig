import { faker } from '@faker-js/faker';
import { existsSync } from 'node:fs';
import { chmod, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { runId } from '../../../tests/support/builders.js';
import { createRunWorktree } from '../../../tests/support/run-worktree.js';
import { CommitImportRefused, MergeFailed } from '../../domain/errors.js';
import { isWorkingTreeClean } from '../../git/repository.js';
import type { SandboxGit } from '../../ports/sandbox-git.js';
import { GitWorkspace } from './git-workspace.js';

describe('GitWorkspace', () => {
  it("measures the run branch's commits since a point, by files and lines", async () => {
    const { workspace, writeInSandbox: writeInWorktree, save } = await setup();
    const since = (await workspace.forkPoint()).unwrap();
    await writeInWorktree('one.txt', 'a\nb\nc\n');
    await writeInWorktree('two.txt', 'd\n');
    await save();

    const summary = (await workspace.summariseCommitsSince(since)).unwrap();

    expect(summary).toEqual({
      sha: (await workspace.headCommit()).unwrap(),
      filesChanged: 2,
      insertions: 4,
      deletions: 0,
    });
  });

  it('commits nothing when the worktree has no changes', async () => {
    const { workspace, save } = await setup();
    const head = (await workspace.headCommit()).unwrap();

    await save();

    expect((await workspace.headCommit()).unwrap()).toBe(head);
    expect((await workspace.forkPoint()).unwrap()).toBe(head);
  });

  it('leaves the host branch alone until work is saved, then carries it over with its SHA', async () => {
    const { workspace, git, runBranch, inSandbox, writeInSandbox, save, forkPoint } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    await inSandbox.add('-A').commit(faker.git.commitMessage());
    expect(await git.revparse([runBranch])).toBe(forkPoint);

    (await save()).unwrap();

    expect((await workspace.headCommit()).unwrap()).toBe(await inSandbox.revparse(['HEAD']));
  });

  it('commits what an agent left uncommitted inside the sandbox', async () => {
    const { workspace, inSandbox, writeInSandbox, git, runBranch } = await setup();
    const message = faker.lorem.sentence();
    const approved = (await workspace.forkPoint()).unwrap();
    await writeInSandbox('feature.txt', faker.lorem.sentence());

    (await workspace.saveWork(message, { approved })).unwrap();

    expect((await inSandbox.log(['-1'])).latest?.message).toBe(message);
    expect((await git.log([runBranch, '-1'])).latest?.message).toBe(message);
  });

  it('takes an amended commit when the commit it replaces was not approved yet', async () => {
    const { workspace, inSandbox, writeInSandbox, save } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    const first = (await workspace.headCommit()).unwrap();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    await inSandbox.add('-A').raw(['commit', '--amend', '-m', faker.git.commitMessage()]);

    (await save()).unwrap();

    const amended = await inSandbox.revparse(['HEAD']);
    expect(amended).not.toBe(first);
    expect((await workspace.headCommit()).unwrap()).toBe(amended);
  });

  it('follows the sandbox back to the approved commit when an agent undoes its work', async () => {
    const { workspace, inSandbox, writeInSandbox, save, forkPoint } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    await inSandbox.raw(['reset', '--hard', forkPoint]);

    (await save()).unwrap();

    expect((await workspace.headCommit()).unwrap()).toBe(forkPoint);
  });

  it('refuses work that rewrites an approved commit and leaves the host branch as it was', async () => {
    const { workspace, inSandbox, writeInSandbox, save, saveAfter } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    const approved = (await workspace.headCommit()).unwrap();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    await inSandbox.add('-A').raw(['commit', '--amend', '-m', faker.git.commitMessage()]);

    const refusal = await saveAfter(approved);

    expect(refusal.isErr() && refusal.error).toBeInstanceOf(CommitImportRefused);
    expect((await workspace.headCommit()).unwrap()).toBe(approved);
  });

  it.each([{ reported: 'not a sha' }, { reported: 'a'.repeat(40) }])(
    'refuses a sandbox that reports $reported as its head',
    async ({ reported }) => {
      const { workspaceOn, writeInSandbox, inSandbox, git, runBranch, forkPoint, agent } =
        await setup();
      await writeInSandbox('feature.txt', faker.lorem.sentence());
      await inSandbox.add('-A').commit(faker.git.commitMessage());
      const lying = mock<SandboxGit>({
        execGit: async (args) =>
          args[0] === 'rev-parse' ? { exitCode: 0, output: reported } : agent.execGit(args),
        copyOut: (from, to) => agent.copyOut(from, to),
      });

      const refusal = await workspaceOn(lying).saveWork(faker.git.commitMessage(), {
        approved: forkPoint,
      });

      expect(refusal.isErr() && refusal.error).toBeInstanceOf(CommitImportRefused);
      expect(await git.revparse([runBranch])).toBe(forkPoint);
    },
  );

  it('runs none of the host repository hooks while importing', async () => {
    const { repo, inSandbox, writeInSandbox, save } = await setup();
    const marker = path.join(repo, `${faker.string.uuid()}.marker`);
    const hook = path.join(repo, '.git', 'hooks', 'reference-transaction');
    await writeFile(hook, `#!/bin/sh\ntouch "${marker}"\n`);
    await chmod(hook, 0o755);
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    await inSandbox.add('-A').commit(faker.git.commitMessage());

    (await save()).unwrap();

    expect(existsSync(marker)).toBe(false);
  });

  it("reads a file from the operator's repository, and nothing for one that is not there", async () => {
    const { workspace, repo } = await setup();
    const contents = faker.lorem.paragraph();
    await writeFile(path.join(repo, 'NOTES.md'), contents);

    expect(await workspace.readRepoFile('NOTES.md')).toBe(contents);
    expect(await workspace.readRepoFile(`${faker.string.uuid()}.md`)).toBeUndefined();
  });

  it('aborts a conflicting merge and reports it as a failed merge', async () => {
    const { workspace, repo, git, writeInSandbox: writeInWorktree, save } = await setup();
    await writeInWorktree('README.md', faker.lorem.paragraph());
    await save();
    await writeFile(path.join(repo, 'README.md'), faker.lorem.paragraph());
    await git.add('README.md').commit(faker.git.commitMessage());

    const merge = await workspace.mergeRunBranch();

    expect(merge.isErr() && merge.error).toBeInstanceOf(MergeFailed);
    expect(existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect((await git.status()).conflicted).toEqual([]);
    expect((await isWorkingTreeClean(repo)).unwrap()).toBe(true);
    expect((await workspace.isRunBranchMerged()).unwrap()).toBe(false);
  });

  it('names the run and base branch when the merge is refused', async () => {
    const { workspace, repo, writeInSandbox: writeInWorktree, save } = await setup();
    await writeInWorktree('feature.txt', faker.lorem.paragraph());
    await save();
    await writeFile(path.join(repo, `${faker.string.uuid()}.txt`), faker.lorem.paragraph());

    const merge = await workspace.mergeRunBranch();

    expect(merge.isErr() && merge.error.message).toMatch(
      /^Merging "jig\/run\/.+" into "main" failed: Refusing to merge: .* has uncommitted changes$/,
    );
  });

  async function setup() {
    const id = runId();
    const created = await createRunWorktree(id);
    const { workspace, repo, git, runBranch, worktreePath, inSandbox, agent } = created;
    const forkPoint = (await workspace.forkPoint()).unwrap();
    const writeInSandbox = (file: string, contents: string) =>
      writeFile(path.join(created.sandboxPath, file), contents);
    const saveAfter = (approved: string) =>
      workspace.saveWork(faker.git.commitMessage(), { approved });
    const workspaceOn = (sandbox: SandboxGit) =>
      new GitWorkspace({
        repoRoot: repo.dir,
        worktreePath,
        runId: id,
        baseBranch: 'main',
        sandbox,
      });
    return {
      workspace,
      workspaceOn,
      repo: repo.dir,
      git,
      runBranch,
      inSandbox,
      agent,
      forkPoint,
      writeInSandbox,
      save: () => saveAfter(forkPoint),
      saveAfter,
    };
  }
});
