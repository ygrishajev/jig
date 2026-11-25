import { faker } from '@faker-js/faker';
import { panic, Result } from 'better-result';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { ChangedFile } from '../../src/domain/protected-paths.js';
import type { GitFacts } from '../../src/domain/work-facts.js';
import {
  CommitImportRefused,
  CommitRejected,
  MergeFailed,
  type Workspace,
} from '../../src/ports/workspace.js';

type Files = Record<string, string>;

interface FakeCommit {
  sha: string;
  message: string;
  files: Files;
}

/**
 * A run branch kept in memory, taking its work from the directory a fake agent writes to. A commit
 * is the files it holds, so the same files are the same tree, as they are in git.
 */
export class FakeWorkspace implements Workspace {
  mergeAttempts = 0;
  private readonly root = aCommitOf({}, faker.git.commitMessage());
  private readonly commits = [this.root];
  private sandboxHead = this.root;
  private base: Files = this.root.files;
  private readonly rejections: string[] = [];

  constructor(
    private readonly sandboxPath: string,
    private readonly repoFiles: Files = {},
  ) {}

  /** The commits the run made, oldest first, as anyone reading its branch sees them. */
  get history() {
    return this.commits.slice(1).map(({ message, files }) => ({ message, files }));
  }

  /** Whether the base branch holds exactly what the run branch does. */
  get merged() {
    return treeOf(this.base) === treeOf(this.tip.files);
  }

  /** The repository's hooks refuse the next commit, printing `output`. */
  rejectNextCommit(output: string) {
    this.rejections.push(output);
  }

  /** A person merges the run branch, outside jig. */
  mergeByHand() {
    this.base = this.tip.files;
  }

  /** A commit that reaches the run branch on the host without going through the sandbox. */
  commitOnHost() {
    const files = { ...this.tip.files, [`${faker.string.uuid()}.txt`]: faker.lorem.sentence() };
    this.commits.push(aCommitOf(files, faker.git.commitMessage()));
  }

  async saveWork(message: string, { approved }: { approved: string }) {
    const files = await this.sandboxFiles();
    const dirty = treeOf(files) !== treeOf(this.sandboxHead.files);
    const output = dirty ? this.rejections.shift() : undefined;
    if (output !== undefined) {
      return Result.err(new CommitRejected({ message: faker.lorem.sentence(), output }));
    }
    if (!this.commits.some(({ sha }) => sha === approved)) {
      return Result.err(new CommitImportRefused({ message: faker.lorem.sentence() }));
    }
    if (dirty) {
      this.sandboxHead = aCommitOf(files, message);
      this.commits.push(this.sandboxHead);
    }
    return Result.ok();
  }

  async headCommit() {
    return Result.ok(this.tip.sha);
  }

  async forkPoint() {
    return Result.ok(this.root.sha);
  }

  async summariseCommitsSince(since: string) {
    const filesChanged = this.changesSince(since).length;
    return Result.ok({ sha: this.tip.sha, filesChanged, insertions: filesChanged, deletions: 0 });
  }

  async changedFilesSince(start: string) {
    return Result.ok(this.changesSince(start));
  }

  async collectFacts() {
    const clean = treeOf(await this.sandboxFiles()) === treeOf(this.sandboxHead.files);
    return Result.ok({
      host: factsOf(this.tip, true),
      sandbox: factsOf(this.sandboxHead, clean),
    });
  }

  async readRepoFile(relativePath: string): Promise<string | undefined> {
    return this.repoFiles[relativePath];
  }

  async mergeRunBranch({ approved }: { approved: string | undefined }) {
    this.mergeAttempts += 1;
    const reviewed = this.commits.find(({ sha }) => sha === approved);
    if (!reviewed || treeOf(reviewed.files) !== treeOf(this.tip.files)) {
      return Result.err(new MergeFailed({ message: faker.lorem.sentence() }));
    }
    this.mergeByHand();
    return Result.ok();
  }

  async isRunBranchMerged() {
    return Result.ok(this.merged);
  }

  private get tip() {
    return this.commits.at(-1) ?? this.root;
  }

  private changesSince(start: string): ChangedFile[] {
    const before = this.commits.find(({ sha }) => sha === start)?.files;
    if (!before) panic(`The fake run branch has no commit ${start}`);
    const after = this.tip.files;
    const touched = [...new Set([...Object.keys(before), ...Object.keys(after)])];
    return touched
      .filter((file) => before[file] !== after[file])
      .map((file) => ({ path: file, kind: kindOfChange(before[file], after[file]) }));
  }

  private async sandboxFiles(): Promise<Files> {
    const entries = await readdir(this.sandboxPath, { recursive: true, withFileTypes: true });
    const contents = entries
      .filter((entry) => entry.isFile())
      .map(async (entry) => {
        const file = path.join(entry.parentPath, entry.name);
        return [path.relative(this.sandboxPath, file), await readFile(file, 'utf-8')] as const;
      });
    return Object.fromEntries(await Promise.all(contents));
  }
}

function aCommitOf(files: Files, message: string): FakeCommit {
  return { sha: faker.git.commitSha(), message, files };
}

function treeOf(files: Files): string {
  const sorted = Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1));
  return createHash('sha1').update(JSON.stringify(sorted)).digest('hex');
}

function factsOf({ sha, files }: FakeCommit, clean: boolean): GitFacts {
  return { commit: sha, tree: treeOf(files), clean };
}

function kindOfChange(before: string | undefined, after: string | undefined) {
  if (before === undefined) return 'added';
  return after === undefined ? 'deleted' : 'modified';
}
