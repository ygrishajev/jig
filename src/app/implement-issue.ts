import { Result } from 'better-result';

import type { GithubSettingsInvalid } from '../config/errors.js';
import { type GithubSettings, githubSettingsFrom } from '../config/github-settings.js';
import { outcomeIsComplete } from '../domain/invocation-status.js';
import {
  commentMarker,
  commentReceipt,
  findingsCommentReceipt,
  type FindingsIdentity,
  findingsMarker,
  type PullRequestReceipt,
  pullRequestReceipt,
  type Refusal,
  refusalCommentReceipt,
  refusalMarker,
  refusalOf,
  withComment,
  withFindingsComment,
  withPullRequest,
  withRefusal,
  withRefusalComment,
} from '../domain/orchestration.js';
import type { RepositoryIdentity } from '../domain/repository-identity.js';
import type { GitCommandFailed, RepositoryInvalid } from '../ports/git-failures.js';
import {
  type GithubFailure,
  type GithubOriginDiscovery,
  type GithubPort,
  GithubRefused,
  GithubSetupInvalid,
  type OpenPullRequest,
} from '../ports/github.js';
import type {
  PublicationInProgress,
  PublicationOwnership,
  ReceiptStore,
  ReceiptStoreFailure,
} from '../ports/publication-receipts.js';
import type { CodeCheckpoint, RunBranches, RunBranchFailure } from '../ports/run-branches.js';
import type { RunStoreFailure, RunStoreSetupInvalid } from '../ports/run-store.js';
import { BaseBranchMismatch } from './errors.js';
import { findingsCommentBody } from './findings-comment.js';
import { pullRequestFor, refusalCommentBody, statusCommentBody } from './publication-content.js';
import { type WhileOwned, withPublicationOwnership } from './publication-ownership.js';
import type { EnvironmentVariables } from './repository-preparation.js';
import { acceptedRequestFor } from './request-snapshot.js';
import { type RunCapabilities, runJig, type RunJigFailure, type RunReport } from './run-jig.js';
import {
  type RunOperationCapabilities,
  type RunPreparation,
  type RunPreparationFailure,
  withPreparedRun,
} from './run-operation.js';
import { openRunStore } from './run-stores.js';

export type IssueOutcome =
  | { kind: 'pullRequest'; url: string; reused: boolean }
  | { kind: 'draftPullRequest'; url: string; reused: boolean; findingsUrl: string }
  | { kind: 'commented'; outcome: RunReport['status']; url: string }
  | { kind: 'refused'; paths: string[]; url: string };

/** The issue to implement, and how the operator asked its run's repository to be prepared. */
export interface IssueInput extends RunPreparation {
  issueNumber: number;
}

/**
 * What issue implementation needs besides the run itself: the GitHub API for a token, the clone's
 * GitHub origin, and the receipts and run branches of the clone it runs in. Each is asked for only
 * once the issue flow reaches it.
 */
export interface IssueCapabilities extends RunOperationCapabilities {
  githubFor(token: string): GithubPort;
  githubOriginName: GithubOriginDiscovery;
  publicationAt(repoRoot: string): IssuePublication;
}

/** The shared receipts and leases, and the guarded run branches, of one clone. */
export interface IssuePublication {
  receipts: ReceiptStore & PublicationOwnership;
  runBranches: RunBranches;
}

export type IssueFailure =
  | GithubSetupInvalid
  | RunPreparationFailure
  | RunJigFailure
  | GithubFailure
  | ReceiptStoreFailure
  | PublicationInProgress
  | RunBranchFailure
  | RepositoryInvalid
  | BaseBranchMismatch;

/** The run an issue is implemented in, in the clone it runs in, and the GitHub API it publishes to. */
interface IssueRun {
  run: RunCapabilities;
  repoRoot: string;
  github: GithubPort;
  publicationAt(repoRoot: string): IssuePublication;
}

/**
 * Where the accepted request is published: the issue, its key in the receipts, its default branch,
 * and the ownership every outward-facing step runs under.
 */
interface IssueTarget {
  github: GithubPort;
  repository: RepositoryIdentity;
  issueNumber: number;
  key: string;
  base: string;
  title: string;
  whileOwned: WhileOwned;
}

/** What reading the run's saved state back needs: the stores the run was saved to. */
type RunStoreSelection = Pick<RunCapabilities, 'runStores' | 'config'>;

type Publication =
  { kind: 'comment'; revision?: string } | { kind: 'ready' | 'draft'; revision: string };

type PublicationFailure = GithubFailure | ReceiptStoreFailure | PublicationInProgress;

/**
 * Implements GitHub issue `issueNumber` in the repository the caller is in. The GitHub settings
 * are refused before the repository is prepared or anything is built, and the token before the
 * origin is asked for; the run then executes as `jig run` would and its outcome is published.
 */
export function implementGithubIssue(
  capabilities: IssueCapabilities,
  { issueNumber, ...preparation }: IssueInput,
): Promise<Result<IssueOutcome, IssueFailure>> {
  return Result.gen(async function* () {
    const { cwd, environment } = capabilities.context();
    const { token, repository } = yield* Result.await(
      githubSettingsAt(environment, () => capabilities.githubOriginName(cwd)),
    );
    const github = capabilities.githubFor(token);
    return await withPreparedRun(capabilities, preparation, (run, repoRoot) =>
      implementIssue(
        { run, repoRoot, github, publicationAt: capabilities.publicationAt },
        repository,
        issueNumber,
      ),
    );
  });
}

/**
 * A settings refusal becomes the GitHub port's `GithubSetupInvalid`, so the operation fails with
 * one setup identity whichever check refused it.
 */
async function githubSettingsAt(
  environment: EnvironmentVariables,
  originName: () => ReturnType<GithubOriginDiscovery>,
): Promise<Result<GithubSettings, GithubSetupInvalid>> {
  const settings = await githubSettingsFrom(environment, originName);
  return settings.mapError((failure) =>
    failure._tag === 'GithubSettingsInvalid' ? asSetupInvalid(failure) : failure,
  );
}

function asSetupInvalid({ message }: GithubSettingsInvalid): GithubSetupInvalid {
  return new GithubSetupInvalid({ message });
}

/**
 * Implements issue `issueNumber` as one run on the default branch: accepts the issue once, runs
 * its snapshot through `runJig` with its state required on the remote and its code held back, and
 * publishes the outcome under the publication lease.
 */
function implementIssue(
  { run, repoRoot, github, publicationAt }: IssueRun,
  repository: RepositoryIdentity,
  issueNumber: number,
): Promise<Result<IssueOutcome, IssueFailure>> {
  return Result.gen(async function* () {
    const { log } = run;
    log.info(
      { event: 'githubIssuePreparationStarted', issueNumber, repository },
      `Checking GitHub issue #${issueNumber} in ${repository.owner}/${repository.repo}`,
    );
    const { receipts, runBranches } = publicationAt(repoRoot);
    const base = yield* Result.await(github.getDefaultBranch(repository));
    const current = yield* Result.await(runBranches.checkedOutBranch());
    if (current !== base)
      return Result.err(
        new BaseBranchMismatch({
          message: `Check out the default branch "${base}" before implementing an issue (currently "${current}").`,
        }),
      );
    const key = `${repository.owner}/${repository.repo}#${issueNumber}`;
    log.info(
      { event: 'githubIssueRequestStarted', issueNumber },
      `Loading accepted request or fetching GitHub issue #${issueNumber}`,
    );
    const accepted = yield* Result.await(
      acceptedRequestFor(receipts, { github, repository, issueNumber, key }),
    );
    log.info(
      { event: 'githubIssueRequestAccepted', issueNumber, runId: accepted.runId },
      `GitHub issue #${issueNumber} is ready as run ${accepted.runId}`,
    );
    const report = yield* Result.await(
      runJig(run, {
        start: { text: accepted.text, merge: false, codePublication: 'deferred' },
        runId: accepted.runId,
        requiredStores: REQUIRED_STORES,
      }),
    );
    log.info(
      {
        event: 'githubIssueRunFinished',
        issueNumber,
        runId: accepted.runId,
        status: report.status,
      },
      `Run ${accepted.runId} finished ${report.status}; publishing the GitHub outcome`,
    );
    const target = { github, repository, issueNumber, key, base, title: accepted.title };
    return withPublicationOwnership(receipts, key, log, (whileOwned) =>
      publishOutcome(run, { receipts, runBranches }, { ...target, whileOwned }, report),
    );
  });
}

/** Issue runs always keep their state on the remote, so a retried job on another clone resumes it. */
const REQUIRED_STORES = ['git-remote'];

/**
 * Publishes what the run left: a ready PR for a completed run with approved changes, a draft PR
 * with a findings comment for a stuck run that committed work, a refusal for one that changes a
 * workflow, and a status comment otherwise. Every run with code is inspected before any receipt is
 * reused, and its code reaches the remote only through `RunBranches.publish`.
 */
function publishOutcome(
  run: RunStoreSelection,
  { receipts: store, runBranches }: IssuePublication,
  target: IssueTarget,
  report: RunReport,
): Promise<Result<IssueOutcome, IssueFailure>> {
  return Result.gen(async function* () {
    const checkpoint = yield* Result.await(codeCheckpointOf(run, runBranches, report));
    const publication = yield* Result.await(publicationFor(runBranches, report, checkpoint));
    if (publication.kind === 'comment')
      return publishStatus(runBranches, store, target, { report, revision: publication.revision });
    const { revision } = publication;
    const pushed = yield* Result.await(
      target.whileOwned(() =>
        runBranches.publish({
          runId: report.state.runId,
          revision,
          defaultBranch: target.base,
          pushUnchanged: publication.kind === 'draft',
        }),
      ),
    );
    if (pushed.kind === 'refused')
      return refuse(store, target, { runId: report.state.runId, revision, paths: pushed.paths });
    if (pushed.kind === 'unchanged') return publishComment(store, target, { report, revision });
    const pullRequest = pullRequestFor(report, {
      title: target.title,
      issueNumber: target.issueNumber,
      draft: publication.kind === 'draft',
    });
    if (publication.kind === 'ready') return publishReady(store, target, pullRequest);
    return publishDraft(store, target, {
      report,
      revision,
      pullRequest,
      changesFiles: pushed.changesFiles,
    });
  });
}

/**
 * The code checkpoint the run's saved state records, which the run branch must still hold. A run
 * saved before checkpoints were recorded has none, so its branch here is what gets inspected, and
 * it has no starting commit to tell its work by.
 */
function codeCheckpointOf(
  { runStores, config }: RunStoreSelection,
  runBranches: RunBranches,
  report: RunReport,
): Promise<Result<CodeCheckpoint, RunStoreSetupInvalid | RunStoreFailure | GitCommandFailed>> {
  return Result.gen(async function* () {
    const { runId } = report.state;
    const store = yield* Result.await(openRunStore(runStores, config, REQUIRED_STORES));
    const saved = yield* Result.await(store.peek(runId));
    if (saved?.codeRevision)
      return Result.ok({ startingCommit: saved.startingCommit, codeRevision: saved.codeRevision });
    const head = yield* Result.await(runBranches.head(runId));
    return Result.ok({ codeRevision: head });
  });
}

/**
 * A completed run with code is offered as a ready PR and a stuck run with commits past where it
 * started as a draft; every other run, and one with no code, is reported in an issue comment.
 */
function publicationFor(
  runBranches: RunBranches,
  report: RunReport,
  checkpoint: CodeCheckpoint,
): Promise<Result<Publication, GitCommandFailed>> {
  return Result.gen(async function* () {
    const revision = checkpoint.codeRevision;
    if (!revision) return Result.ok<Publication>({ kind: 'comment' });
    if (outcomeIsComplete(report.status))
      return Result.ok<Publication>({ kind: 'ready', revision });
    if (report.status !== 'stuck') return Result.ok<Publication>({ kind: 'comment', revision });
    const committed = yield* Result.await(runBranches.hasWorkBeyondStart(checkpoint));
    return Result.ok<Publication>({ kind: committed ? 'draft' : 'comment', revision });
  });
}

function publishStatus(
  runBranches: RunBranches,
  store: ReceiptStore,
  target: IssueTarget,
  { report, revision }: { report: RunReport; revision?: string },
): Promise<Result<IssueOutcome, RunBranchFailure | PublicationFailure>> {
  return Result.gen(async function* () {
    if (!revision) return publishComment(store, target, { report });
    const { runId } = report.state;
    const inspection = yield* Result.await(
      runBranches.inspect({ runId, revision, defaultBranch: target.base }),
    );
    if (inspection.kind === 'refused')
      return refuse(store, target, { runId, revision, paths: inspection.paths });
    return publishComment(store, target, { report, revision });
  });
}

function publishComment(
  store: ReceiptStore,
  target: IssueTarget,
  { report, revision }: { report: RunReport; revision?: string },
): Promise<Result<IssueOutcome, PublicationFailure>> {
  return Result.gen(async function* () {
    const identity = {
      runId: report.state.runId,
      outcome: report.status,
      revision: revision ?? NO_CODE_REVISION,
    };
    const state = yield* Result.await(store.read());
    const url = yield* Result.await(
      commentOnce(target, target.issueNumber, {
        receipt: commentReceipt(state, identity),
        marker: commentMarker(identity),
        body: statusCommentBody(report),
        save: (url) => store.update((state) => withComment(state, identity, url)),
      }),
    );
    return Result.ok<IssueOutcome>({ kind: 'commented', outcome: report.status, url });
  });
}

/** Stands in for the revision of a run that has no code yet, so its comment is still keyed. */
const NO_CODE_REVISION = 'none';

/**
 * Posts a comment on issue or PR `number` at most once: a saved receipt is reused, and a comment
 * posted before its receipt was saved is found again by its marker instead of being posted twice.
 */
function commentOnce(
  { github, repository, whileOwned }: IssueTarget,
  number: number,
  comment: {
    receipt: string | undefined;
    marker: string;
    body: string;
    save: (url: string) => Promise<Result<unknown, ReceiptStoreFailure>>;
  },
): Promise<Result<string, PublicationFailure>> {
  return Result.gen(async function* () {
    if (comment.receipt) return Result.ok(comment.receipt);
    const found = yield* Result.await(github.findIssueComment(repository, number, comment.marker));
    const url =
      found ??
      (yield* Result.await(
        whileOwned(() =>
          github.commentOnIssue(repository, number, `${comment.body}\n\n${comment.marker}`),
        ),
      ));
    yield* Result.await(comment.save(url));
    return Result.ok(url);
  });
}

/** Records the refusal before announcing it, so a crash in between still never publishes the code. */
function refuse(
  store: ReceiptStore,
  target: IssueTarget,
  refusal: Refusal,
): Promise<Result<IssueOutcome, PublicationFailure>> {
  return Result.gen(async function* () {
    const { key } = target;
    const state = yield* Result.await(store.update((state) => withRefusal(state, key, refusal)));
    const recorded = refusalOf(state, key, refusal.revision) ?? refusal;
    const url = yield* Result.await(
      commentOnce(target, target.issueNumber, {
        receipt: refusalCommentReceipt(state, key, refusal.revision),
        marker: refusalMarker(key, refusal.revision),
        body: refusalCommentBody(recorded),
        save: (url) =>
          store.update((state) => withRefusalComment(state, key, refusal.revision, url)),
      }),
    );
    return Result.ok<IssueOutcome>({ kind: 'refused', paths: recorded.paths, url });
  });
}

function publishReady(
  store: ReceiptStore,
  target: IssueTarget,
  publication: OpenPullRequest,
): Promise<Result<IssueOutcome, PublicationFailure>> {
  return Result.gen(async function* () {
    const { receipt, reused } = yield* Result.await(
      openPullRequestOnce(store, target, publication),
    );
    return Result.ok<IssueOutcome>({ kind: 'pullRequest', url: receipt.url, reused });
  });
}

/** Reuses the issue's recorded PR, or one open for the same head, before opening a new one. */
function openPullRequestOnce(
  store: ReceiptStore,
  { github, repository, key, whileOwned }: IssueTarget,
  publication: OpenPullRequest,
): Promise<Result<{ receipt: PullRequestReceipt; reused: boolean }, PublicationFailure>> {
  return Result.gen(async function* () {
    const state = yield* Result.await(store.read());
    const recorded = pullRequestReceipt(state, key);
    if (recorded) return Result.ok({ receipt: recorded, reused: true });
    const found = yield* Result.await(
      github.findOpenPullRequestByHead(repository, publication.head),
    );
    const pr =
      found ??
      (yield* Result.await(whileOwned(() => github.openPullRequest(repository, publication))));
    yield* Result.await(store.update((state) => withPullRequest(state, key, pr)));
    return Result.ok({ receipt: { number: pr.number, url: pr.url }, reused: !!found });
  });
}

/**
 * Opens the draft, then makes sure it carries its findings comment: a PR whose comment failed, or
 * one recorded before findings were posted, still gets exactly one.
 */
function publishDraft(
  store: ReceiptStore,
  target: IssueTarget,
  draft: {
    report: RunReport;
    revision: string;
    pullRequest: OpenPullRequest;
    changesFiles: boolean;
  },
): Promise<Result<IssueOutcome, PublicationFailure>> {
  return Result.gen(async function* () {
    const { report, revision } = draft;
    const opened = await openPullRequestOnce(store, target, draft.pullRequest);
    if (opened.isErr()) return Result.err(explainRefusedDraft(opened.error, draft));
    const { receipt, reused } = opened.value;
    const identity: FindingsIdentity = {
      repository: target.repository,
      pullRequest: receipt.number,
      runId: report.state.runId,
      outcome: report.status,
      revision,
    };
    const state = yield* Result.await(store.read());
    const findingsUrl = yield* Result.await(
      commentOnce(target, receipt.number, {
        receipt: findingsCommentReceipt(state, identity),
        marker: findingsMarker(identity),
        body: findingsCommentBody(report.state, revision),
        save: (url) => store.update((state) => withFindingsComment(state, identity, url)),
      }),
    );
    return Result.ok<IssueOutcome>({
      kind: 'draftPullRequest',
      url: receipt.url,
      reused,
      findingsUrl,
    });
  });
}

/** GitHub may refuse a PR whose commits change no files; say so rather than leave it a puzzle. */
function explainRefusedDraft(
  error: PublicationFailure,
  { pullRequest, changesFiles }: { pullRequest: OpenPullRequest; changesFiles: boolean },
): PublicationFailure {
  if (changesFiles || error._tag !== 'GithubRefused') return error;
  return new GithubRefused({
    message: `${error.message} The commits on ${pullRequest.head} change no files against ${pullRequest.base}, so there is no diff for a draft PR; inspect the branch by hand.`,
  });
}
