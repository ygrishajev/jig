import { Result } from 'better-result';

import { unpublishablePaths } from '../../domain/protected-paths.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import type {
  GitCommandFailed,
  RemoteUnavailable,
  RepositoryInvalid,
} from '../../ports/git-failures.js';
import {
  type CodeCheckpoint,
  type InspectedRevision,
  type RunBranches,
  type RunBranchFailure,
  type RunBranchInspection,
  type RunBranchPublication,
  RunBranchUnpublishable,
} from '../../ports/run-branches.js';
import type { RunStateConflict } from '../../ports/run-state-failures.js';
import { getCurrentBranch } from './branch.js';
import { RemoteRef } from './remote-ref.js';
import { isAncestor } from './repository.js';
import { changedPaths, commitsBeyond, exactHead, hasCommit, mergeBaseWith } from './run-history.js';

export class GitRunBranches implements RunBranches {
  private readonly refs: RemoteRef;

  constructor(private readonly repoRoot: string) {
    this.refs = new RemoteRef(repoRoot);
  }

  checkedOutBranch(): Promise<Result<string, RepositoryInvalid | GitCommandFailed>> {
    return getCurrentBranch(this.repoRoot);
  }

  head(runId: RunId): Promise<Result<string | undefined, GitCommandFailed>> {
    return exactHead(this.repoRoot, branchRef(runId));
  }

  async hasWorkBeyondStart({
    startingCommit,
    codeRevision,
  }: CodeCheckpoint): Promise<Result<boolean, GitCommandFailed>> {
    if (!startingCommit || !codeRevision) return Result.ok(false);
    const commits = await commitsBeyond(this.repoRoot, startingCommit, codeRevision);
    return commits.map((beyond) => beyond.length > 0);
  }

  publish({
    pushUnchanged = false,
    ...inspected
  }: InspectedRevision & { pushUnchanged?: boolean }): Promise<
    Result<RunBranchPublication, RunBranchFailure>
  > {
    return Result.gen(async function* (this: GitRunBranches) {
      const { runId, revision } = inspected;
      const head = yield* Result.await(this.head(runId));
      if (head !== revision)
        return Result.err(
          new RunBranchUnpublishable({
            message: `Run branch ${runBranchFor(runId)} is at ${head ?? 'nothing'}, not the checkpoint ${revision} its state records; move it back to the checkpoint or start a new run.`,
          }),
        );
      const inspection = yield* Result.await(this.inspect(inspected));
      if (inspection.kind === 'refused') return Result.ok<RunBranchPublication>(inspection);
      const { changesFiles } = inspection;
      if (!changesFiles && !pushUnchanged)
        return Result.ok<RunBranchPublication>({ kind: 'unchanged' });
      yield* Result.await(this.pushLeased(runId, revision));
      return Result.ok<RunBranchPublication>({ kind: 'published', changesFiles });
    }, this);
  }

  /** Pushes `revision` only over what the remote branch holds now, and only as a fast-forward of it. */
  private pushLeased(runId: RunId, revision: string): Promise<Result<void, RunBranchFailure>> {
    return Result.gen(async function* (this: GitRunBranches) {
      const ref = branchRef(runId);
      const listed = yield* Result.await(this.refs.list([ref]));
      const published = listed.get(ref);
      if (published === revision) return Result.ok();
      if (published) yield* Result.await(this.ensureFastForward(runId, published, revision));
      return this.refs.pushLeased([{ ref, source: revision, expected: published }]);
    }, this);
  }

  private ensureFastForward(
    runId: RunId,
    published: string,
    revision: string,
  ): Promise<Result<void, RunBranchFailure>> {
    return Result.gen(async function* (this: GitRunBranches) {
      if (!(yield* Result.await(hasCommit(this.repoRoot, published))))
        yield* Result.await(
          this.refs.fetch([`+${branchRef(runId)}:refs/remotes/origin/${runBranchFor(runId)}`]),
        );
      if (yield* Result.await(isAncestor(this.repoRoot, published, revision))) return Result.ok();
      return Result.err(
        new RunBranchUnpublishable({
          message: `Run branch ${runBranchFor(runId)} on origin moved to ${published}, which ${revision} does not build on; nothing was pushed.`,
        }),
      );
    }, this);
  }

  inspect({
    runId,
    revision,
    defaultBranch,
  }: InspectedRevision): Promise<Result<RunBranchInspection, RunBranchFailure>> {
    return Result.gen(async function* (this: GitRunBranches) {
      const defaultHead = yield* Result.await(this.fetchedHead(defaultBranch));
      const forkPoint = yield* Result.await(mergeBaseWith(this.repoRoot, defaultHead, revision));
      if (!forkPoint)
        return Result.err(
          new RunBranchUnpublishable({
            message: `Run branch ${runBranchFor(runId)} shares no history with ${defaultBranch}.`,
          }),
        );
      const paths = yield* Result.await(changedPaths(this.repoRoot, forkPoint, revision));
      const refused = unpublishablePaths(paths);
      if (refused.length > 0)
        return Result.ok<RunBranchInspection>({ kind: 'refused', paths: refused });
      return Result.ok<RunBranchInspection>({ kind: 'clean', changesFiles: paths.length > 0 });
    }, this);
  }

  private fetchedHead(
    branch: string,
  ): Promise<Result<string, RunBranchUnpublishable | RemoteUnavailable | RunStateConflict>> {
    return Result.gen(async function* (this: GitRunBranches) {
      const ref = `refs/heads/${branch}`;
      const listed = yield* Result.await(this.refs.list([ref]));
      const head = listed.get(ref);
      if (!head)
        return Result.err(
          new RunBranchUnpublishable({ message: `Default branch ${branch} is missing on origin.` }),
        );
      yield* Result.await(this.refs.fetch([`+${ref}:refs/remotes/origin/${branch}`]));
      return Result.ok(head);
    }, this);
  }
}

function branchRef(runId: RunId): string {
  return `refs/heads/${runBranchFor(runId)}`;
}
