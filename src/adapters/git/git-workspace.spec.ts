import { faker } from '@faker-js/faker';
import { Result } from 'better-result';
import { execa } from 'execa';
import { existsSync } from 'node:fs';
import { chmod, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { mock } from 'vitest-mock-extended';

import { runId } from '../../../tests/support/builders.js';
import { createRunWorktree } from '../../../tests/support/run-worktree.js';
import { GitCommandFailed } from '../../ports/git-failures.js';
import { SandboxUnavailable } from '../../ports/sandbox.js';
import type { SandboxGit } from '../../ports/sandbox-git.js';
import { CommitImportRefused, CommitRejected, MergeFailed } from '../../ports/workspace.js';
import { type CommitSigning, GitWorkspace } from './git-workspace.js';
import { isWorkingTreeClean, openRepo } from './repository.js';

describe('GitWorkspace', () => {
  it('reports where the run branch and the sandbox clone stand once work is saved, both clean', async () => {
    const { workspace, git, inSandbox, runBranch, writeInSandbox, save } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();

    const facts = (await workspace.collectFacts()).unwrap();

    expect(facts.host).toEqual({
      commit: await git.revparse([runBranch]),
      tree: await git.revparse([`${runBranch}^{tree}`]),
      clean: true,
    });
    expect(facts.sandbox).toEqual({
      commit: await inSandbox.revparse(['HEAD']),
      tree: await inSandbox.revparse(['HEAD^{tree}']),
      clean: true,
    });
    expect(facts.sandbox.commit).toBe(facts.host.commit);
  });

  it('reports a sandbox that holds uncommitted work as not clean, and the host as it stands', async () => {
    const { workspace, writeInSandbox, save } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    await writeInSandbox('leftover.txt', faker.lorem.sentence());

    const facts = (await workspace.collectFacts()).unwrap();

    expect(facts.sandbox.clean).toBe(false);
    expect(facts.host.clean).toBe(true);
  });

  it('reports a host worktree that holds uncommitted work as not clean', async () => {
    const { workspace, worktreePath, save } = await setup();
    (await save()).unwrap();
    await writeFile(path.join(worktreePath, 'stray.txt'), faker.lorem.sentence());

    const facts = (await workspace.collectFacts()).unwrap();

    expect(facts.host.clean).toBe(false);
    expect(facts.sandbox.clean).toBe(true);
  });

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

  it('reports how the run branch changed every file since a point', async () => {
    const { workspace, inSandbox, writeInSandbox, save } = await setup();
    const original = `${faker.lorem.slug()}.txt`;
    await writeInSandbox(original, faker.lorem.sentence());
    (await save()).unwrap();
    const start = (await workspace.headCommit()).unwrap();
    const added = `${faker.lorem.slug()}.txt`;
    const moved = `${faker.lorem.slug()}.txt`;
    await writeInSandbox(added, faker.lorem.sentence());
    await writeInSandbox('README.md', faker.lorem.paragraph());
    await inSandbox.rm('.gitignore');
    await inSandbox.mv(original, moved);
    await save();

    const changes = (await workspace.changedFilesSince(start)).unwrap();

    expect(changes).toHaveLength(4);
    expect(changes).toEqual(
      expect.arrayContaining([
        { path: added, kind: 'added' },
        { path: 'README.md', kind: 'modified' },
        { path: '.gitignore', kind: 'deleted' },
        { path: moved, kind: 'renamed' },
      ]),
    );
  });

  it('reports no changed files when the point is the head itself', async () => {
    const { workspace } = await setup();
    const head = (await workspace.headCommit()).unwrap();

    const changes = (await workspace.changedFilesSince(head)).unwrap();

    expect(changes).toEqual([]);
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

  it("reports the hooks' output when the repository's commit hooks reject the commit", async () => {
    const { save, writeInSandbox, rejectCommitsInSandbox, git, runBranch, forkPoint } =
      await setup();
    const hookOutput = faker.lorem.words(4);
    await rejectCommitsInSandbox(hookOutput);
    await writeInSandbox('feature.txt', faker.lorem.sentence());

    const saved = await save();

    expect(saved.isErr() && saved.error).toBeInstanceOf(CommitRejected);
    expect(saved.isErr() && saved.error).toMatchObject({ output: hookOutput });
    expect(await git.revparse([runBranch])).toBe(forkPoint);
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
          args[0] === 'rev-parse'
            ? Result.ok({ exitCode: 0, output: reported })
            : agent.execGit(args),
        copyOut: (from, to) => agent.copyOut(from, to),
      });

      const refusal = await workspaceOn(lying).saveWork(faker.git.commitMessage(), {
        approved: forkPoint,
      });

      expect(refusal.isErr() && refusal.error).toBeInstanceOf(CommitImportRefused);
      expect(await git.revparse([runBranch])).toBe(forkPoint);
    },
  );

  it('reports an ancestry failure after fetching the sandbox commits without moving the branch', async () => {
    const { workspace, git, worktreePath, inSandbox, writeInSandbox, saveAfter, forkPoint } =
      await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    await inSandbox.add('-A').commit(faker.git.commitMessage());
    const head = await inSandbox.revparse(['HEAD']);
    const blob = (await git.raw(['hash-object', '-w', 'README.md'])).trim();

    const saved = await saveAfter(blob);

    expect(saved.isErr()).toBe(true);
    expect(saved.isErr() && saved.error).toBeInstanceOf(GitCommandFailed);
    expect(saved.isErr() && saved.error).toMatchObject({
      command: `git merge-base --is-ancestor ${blob} ${head}`,
      output: expect.stringContaining('error'),
    });
    expect(await openRepo(worktreePath).revparse(['FETCH_HEAD'])).toBe(head);
    expect((await workspace.headCommit()).unwrap()).toBe(forkPoint);
  });

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

    const merge = await workspace.mergeRunBranch({
      approved: (await workspace.headCommit()).unwrap(),
    });

    expect(merge.isErr() && merge.error).toBeInstanceOf(MergeFailed);
    expect(existsSync(path.join(repo, '.git', 'MERGE_HEAD'))).toBe(false);
    expect((await git.status()).conflicted).toEqual([]);
    expect((await isWorkingTreeClean(repo)).unwrap()).toBe(true);
    expect((await workspace.isRunBranchMerged()).unwrap()).toBe(false);
  });

  it("leaves agent commits and jig's merge commit unsigned by default", async () => {
    const { workspace, repo, git, writeInSandbox, save, runBranch } = await setup();
    await git.addConfig('commit.gpgsign', 'true');
    await setSigner(repo, 'false');
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    await writeFile(path.join(repo, 'other.txt'), faker.lorem.sentence());
    await git.add('other.txt').raw(['-c', 'commit.gpgsign=false', 'commit', '-m', 'moves main']);

    const merge = await workspace.mergeRunBranch({ approved: await git.revparse([runBranch]) });

    merge.unwrap();
    expect(await git.raw(['cat-file', 'commit', 'HEAD'])).not.toContain('gpgsig');
    expect((await git.raw(['rev-list', '--parents', '-1', 'HEAD'])).trim().split(' ')).toHaveLength(
      3,
    );
  });

  it('signs the run branch with the repository setup at the merge when asked to', async () => {
    const { workspaceOn, agent, repo, git, writeInSandbox, save, runBranch } = await setup();
    await writeFakeSigner(repo);
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    const approved = await git.revparse([runBranch]);

    (await workspaceOn(agent, 'repo').mergeRunBranch({ approved })).unwrap();

    expect(await git.raw(['cat-file', 'commit', 'main'])).toContain('gpgsig');
    expect((await git.log(['main', '-1'])).latest?.author_name).toBe('jig');
  });

  it('merges a signed tip again after an earlier merge attempt stopped', async () => {
    const { workspaceOn, agent, repo, git, writeInSandbox, save, runBranch } = await setup();
    await writeFakeSigner(repo);
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    const approved = await git.revparse([runBranch]);
    const stray = path.join(repo, `${faker.string.uuid()}.txt`);
    await writeFile(stray, faker.lorem.sentence());
    const workspace = workspaceOn(agent, 'repo');
    expect((await workspace.mergeRunBranch({ approved })).isErr()).toBe(true);
    await rm(stray);

    (await workspace.mergeRunBranch({ approved })).unwrap();

    expect(await git.raw(['cat-file', 'commit', 'main'])).toContain('gpgsig');
  });

  it('stops with a failed merge when signing fails, leaving the run branch as it was', async () => {
    const { workspaceOn, agent, repo, git, writeInSandbox, save, runBranch } = await setup();
    await setSigner(repo, 'false');
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    const approved = await git.revparse([runBranch]);

    const merge = await workspaceOn(agent, 'repo').mergeRunBranch({ approved });

    expect(merge.isErr() && merge.error).toBeInstanceOf(MergeFailed);
    expect(await git.revparse([runBranch])).toBe(approved);
  });

  it.each(['status', 'add', 'rev-parse', 'bundle'])(
    'reports git %s failing in the sandbox without moving the host branch',
    async (command) => {
      const { workspaceOn, writeInSandbox, git, runBranch, forkPoint, agent } = await setup();
      await writeInSandbox('feature.txt', faker.lorem.sentence());
      const failing = mock<SandboxGit>({
        execGit: async (args) =>
          args[0] === command
            ? Result.ok({ exitCode: 1, output: faker.lorem.sentence() })
            : agent.execGit(args),
        copyOut: (from, to) => agent.copyOut(from, to),
      });

      const saved = await workspaceOn(failing).saveWork(faker.git.commitMessage(), {
        approved: forkPoint,
      });

      expect(saved.isErr() && saved.error).toBeInstanceOf(GitCommandFailed);
      expect(await git.revparse([runBranch])).toBe(forkPoint);
    },
  );

  it('passes on a sandbox that cannot run git at all', async () => {
    const { workspaceOn, writeInSandbox, git, runBranch, forkPoint, agent } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    const failure = new SandboxUnavailable({ message: faker.lorem.sentence() });
    const dead = mock<SandboxGit>({
      execGit: async () => Result.err(failure),
      copyOut: (from, to) => agent.copyOut(from, to),
    });

    const saved = await workspaceOn(dead).saveWork(faker.git.commitMessage(), {
      approved: forkPoint,
    });

    expect(saved.isErr() && saved.error).toBe(failure);
    expect(await git.revparse([runBranch])).toBe(forkPoint);
  });

  it('copies nothing out when the sandbox has nothing new', async () => {
    const { workspaceOn, writeInSandbox, forkPoint, agent, save } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    const copyOut = vi.fn<SandboxGit['copyOut']>((from, to) => agent.copyOut(from, to));

    const saved = await workspaceOn(
      mock<SandboxGit>({ execGit: (args) => agent.execGit(args), copyOut }),
    ).saveWork(faker.git.commitMessage(), { approved: forkPoint });

    saved.unwrap();
    expect(copyOut).not.toHaveBeenCalled();
  });

  it('removes its copy of the bundle after importing', async () => {
    const { workspaceOn, inSandbox, writeInSandbox, forkPoint, agent } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    await inSandbox.add('-A').commit(faker.git.commitMessage());
    const copied: string[] = [];
    const copyOut = vi.fn<SandboxGit['copyOut']>((from, to) => {
      copied.push(to);
      return agent.copyOut(from, to);
    });

    const saved = await workspaceOn(
      mock<SandboxGit>({ execGit: (args) => agent.execGit(args), copyOut }),
    ).saveWork(faker.git.commitMessage(), { approved: forkPoint });

    saved.unwrap();
    expect(copied).toHaveLength(1);
    expect(existsSync(path.dirname(copied[0]))).toBe(false);
  });

  it('refuses to merge with no approved commit, or one the repository does not have', async () => {
    const { workspace, writeInSandbox, save, git, runBranch } = await setup();
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    const main = await git.revparse(['main']);

    for (const approved of [
      undefined,
      faker.string.hexadecimal({ length: 40, prefix: '', casing: 'lower' }),
    ]) {
      const merge = await workspace.mergeRunBranch({ approved });

      expect(merge.isErr() && merge.error).toBeInstanceOf(MergeFailed);
    }
    expect(await git.revparse(['main'])).toBe(main);
    expect(await git.revparse([runBranch])).not.toBe(main);
  });

  it('signs the merge commit too when asked to', async () => {
    const { workspaceOn, agent, repo, git, writeInSandbox, save, runBranch } = await setup();
    await writeFakeSigner(repo);
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    await writeFile(path.join(repo, 'other.txt'), faker.lorem.sentence());
    await git.add('other.txt').commit(faker.git.commitMessage());
    const approved = await git.revparse([runBranch]);

    (await workspaceOn(agent, 'repo').mergeRunBranch({ approved })).unwrap();

    expect((await git.raw(['rev-list', '--parents', '-1', 'HEAD'])).trim().split(' ')).toHaveLength(
      3,
    );
    expect(await git.raw(['cat-file', 'commit', 'HEAD'])).toContain('gpgsig');
  });

  it('can sign and merge after an earlier signing attempt failed', async () => {
    const { workspaceOn, agent, repo, git, writeInSandbox, save, runBranch } = await setup();
    await setSigner(repo, 'false');
    await writeInSandbox('feature.txt', faker.lorem.sentence());
    (await save()).unwrap();
    const approved = await git.revparse([runBranch]);
    const workspace = workspaceOn(agent, 'repo');
    expect((await workspace.mergeRunBranch({ approved })).isErr()).toBe(true);
    await writeFakeSigner(repo);

    (await workspace.mergeRunBranch({ approved })).unwrap();

    expect(await git.raw(['cat-file', 'commit', 'main'])).toContain('gpgsig');
  });

  it('names the run and base branch when the merge is refused', async () => {
    const { workspace, repo, writeInSandbox: writeInWorktree, save } = await setup();
    await writeInWorktree('feature.txt', faker.lorem.paragraph());
    await save();
    await writeFile(path.join(repo, `${faker.string.uuid()}.txt`), faker.lorem.paragraph());

    const merge = await workspace.mergeRunBranch({
      approved: (await workspace.headCommit()).unwrap(),
    });

    expect(merge.isErr() && merge.error.message).toMatch(
      /^Merging "jig\/run\/.+" into "main" failed: Refusing to merge: .* has uncommitted changes$/,
    );
  });

  async function setup() {
    const id = runId();
    const created = await createRunWorktree(id);
    const {
      workspace,
      repo,
      git,
      runBranch,
      worktreePath,
      inSandbox,
      agent,
      rejectCommitsInSandbox,
    } = created;
    const forkPoint = (await workspace.forkPoint()).unwrap();
    const writeInSandbox = (file: string, contents: string) =>
      writeFile(path.join(created.sandboxPath, file), contents);
    const saveAfter = (approved: string) =>
      workspace.saveWork(faker.git.commitMessage(), { approved });
    const workspaceOn = (sandbox: SandboxGit, signing: CommitSigning = 'skip') =>
      new GitWorkspace({
        repoRoot: repo.dir,
        worktreePath,
        runId: id,
        baseBranch: 'main',
        sandbox,
        signing,
      });
    return {
      workspace,
      workspaceOn,
      worktreePath,
      repo: repo.dir,
      git,
      runBranch,
      inSandbox,
      agent,
      forkPoint,
      writeInSandbox,
      rejectCommitsInSandbox,
      save: () => saveAfter(forkPoint),
      saveAfter,
    };
  }
});

/** Satisfies git's signing protocol, so a spec can see a commit get signed without a real key. */
async function writeFakeSigner(repo: string) {
  const signer = path.join(repo, '.git', 'fake-signer');
  await writeFile(
    signer,
    `#!/bin/sh\ncat > /dev/null\necho '[GNUPG:] SIG_CREATED ' >&2\necho '-----BEGIN PGP SIGNATURE-----'\necho fake\necho '-----END PGP SIGNATURE-----'\n`,
  );
  await chmod(signer, 0o755);
  await setSigner(repo, signer);
}

/** Through git itself: simple-git refuses this setting, as it names a program to run. */
async function setSigner(repo: string, program: string) {
  await execa('git', ['config', 'gpg.program', program], { cwd: repo });
}
