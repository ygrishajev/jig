import { Result } from 'better-result';

import { RemoteRef } from '../../adapters/git/remote-ref.js';
import { isAncestor } from '../../adapters/git/repository.js';
import {
  changedPaths,
  commitsBeyond,
  exactHead,
  hasCommit,
  mergeBaseWith,
} from '../../adapters/git/run-history.js';
import type { GitCommandFailed, RemoteUnavailable, RunStateConflict } from '../../domain/errors.js';
import type { RunId } from '../../domain/run-id.js';
import { runBranchFor, type RunState } from '../../domain/run-state.js';
import { RunBranchUnpublishable } from './errors.js';

export type RunBranchPublication =
  | { kind: 'refused'; paths: string[] }
  | { kind: 'unchanged' }
  | { kind: 'published'; changesFiles: boolean };

export type PublicationFailure =
  RunBranchUnpublishable | GitCommandFailed | RemoteUnavailable | RunStateConflict;

interface InspectedRevision {
  runId: RunId;
  revision: string;
  defaultBranch: string;
}

export type RunBranchInspection =
  { kind: 'refused'; paths: string[] } | { kind: 'clean'; changesFiles: boolean };

/**
 * The only way an issue run's code reaches the remote. It inspects exactly `revision`, refuses it
 * when it changes a workflow, skips it when it changes nothing unless `pushUnchanged` asks for its
 * commits anyway, and otherwise pushes that object ID under a lease on the remote branch. Any
 * failure to inspect publishes nothing.
 */
export function publishRunBranch(
  repoRoot: string,
  { pushUnchanged = false, ...inspected }: InspectedRevision & { pushUnchanged?: boolean },
): Promise<Result<RunBranchPublication, PublicationFailure>> {
  return Result.gen(async function* () {
    const { runId, revision } = inspected;
    const head = yield* Result.await(exactHead(repoRoot, branchRef(runId)));
    if (head !== revision)
      return Result.err(
        new RunBranchUnpublishable({
          message: `Run branch ${runBranchFor(runId)} is at ${head ?? 'nothing'}, not the checkpoint ${revision} its state records; move it back to the checkpoint or start a new run.`,
        }),
      );
    const inspection = yield* Result.await(inspectRunBranch(repoRoot, inspected));
    if (inspection.kind === 'refused') return Result.ok<RunBranchPublication>(inspection);
    const { changesFiles } = inspection;
    if (!changesFiles && !pushUnchanged)
      return Result.ok<RunBranchPublication>({ kind: 'unchanged' });
    yield* Result.await(pushLeased(repoRoot, new RemoteRef(repoRoot), runId, revision));
    return Result.ok<RunBranchPublication>({ kind: 'published', changesFiles });
  });
}

function branchRef(runId: RunId): string {
  return `refs/heads/${runBranchFor(runId)}`;
}

/**
 * What `revision` changes against where it forked from the remote default branch, refused when it
 * changes a workflow. Every publication of an issue run, a status comment included, asks this first.
 */
export function inspectRunBranch(
  repoRoot: string,
  { runId, revision, defaultBranch }: InspectedRevision,
): Promise<Result<RunBranchInspection, PublicationFailure>> {
  return Result.gen(async function* () {
    const defaultHead = yield* Result.await(fetchedHead(new RemoteRef(repoRoot), defaultBranch));
    const forkPoint = yield* Result.await(mergeBaseWith(repoRoot, defaultHead, revision));
    if (!forkPoint)
      return Result.err(
        new RunBranchUnpublishable({
          message: `Run branch ${runBranchFor(runId)} shares no history with ${defaultBranch}.`,
        }),
      );
    const paths = yield* Result.await(changedPaths(repoRoot, forkPoint, revision));
    const workflows = paths.filter(isWorkflowPath);
    if (workflows.length > 0)
      return Result.ok<RunBranchInspection>({ kind: 'refused', paths: workflows });
    return Result.ok<RunBranchInspection>({ kind: 'clean', changesFiles: paths.length > 0 });
  });
}

function fetchedHead(
  refs: RemoteRef,
  branch: string,
): Promise<Result<string, RunBranchUnpublishable | RemoteUnavailable | RunStateConflict>> {
  return Result.gen(async function* () {
    const ref = `refs/heads/${branch}`;
    const listed = yield* Result.await(refs.list([ref]));
    const head = listed.get(ref);
    if (!head)
      return Result.err(
        new RunBranchUnpublishable({ message: `Default branch ${branch} is missing on origin.` }),
      );
    yield* Result.await(refs.fetch([`+${ref}:refs/remotes/origin/${branch}`]));
    return Result.ok(head);
  });
}

function isWorkflowPath(path: string): boolean {
  return path.startsWith(WORKFLOW_DIRECTORY);
}

/** GitHub runs workflows from this directory only; a pushed branch would let them run unreviewed. */
const WORKFLOW_DIRECTORY = '.github/workflows/';

/** Pushes `revision` only over what the remote branch holds now, and only as a fast-forward of it. */
function pushLeased(
  repoRoot: string,
  refs: RemoteRef,
  runId: RunId,
  revision: string,
): Promise<Result<void, PublicationFailure>> {
  return Result.gen(async function* () {
    const ref = branchRef(runId);
    const listed = yield* Result.await(refs.list([ref]));
    const published = listed.get(ref);
    if (published === revision) return Result.ok();
    if (published)
      yield* Result.await(ensureFastForward(repoRoot, refs, runId, published, revision));
    return refs.pushLeased([{ ref, source: revision, expected: published }]);
  });
}

function ensureFastForward(
  repoRoot: string,
  refs: RemoteRef,
  runId: RunId,
  published: string,
  revision: string,
): Promise<Result<void, PublicationFailure>> {
  return Result.gen(async function* () {
    if (!(yield* Result.await(hasCommit(repoRoot, published))))
      yield* Result.await(
        refs.fetch([`+${branchRef(runId)}:refs/remotes/origin/${runBranchFor(runId)}`]),
      );
    if (yield* Result.await(isAncestor(repoRoot, published, revision))) return Result.ok();
    return Result.err(
      new RunBranchUnpublishable({
        message: `Run branch ${runBranchFor(runId)} on origin moved to ${published}, which ${revision} does not build on; nothing was pushed.`,
      }),
    );
  });
}

/**
 * Whether a stuck run committed anything past where it started. A run saved before its starting
 * commit was recorded has no known start, so it is never taken to have work.
 */
export async function hasWorkBeyondStart(
  repoRoot: string,
  { startingCommit, codeRevision }: Pick<RunState, 'startingCommit' | 'codeRevision'>,
): Promise<Result<boolean, GitCommandFailed>> {
  if (!startingCommit || !codeRevision) return Result.ok(false);
  const commits = await commitsBeyond(repoRoot, startingCommit, codeRevision);
  return commits.map((beyond) => beyond.length > 0);
}
