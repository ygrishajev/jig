import { panic, Result } from 'better-result';

import { getCurrentBranch } from '../../adapters/git/branch.js';
import { exactHead } from '../../adapters/git/run-history.js';
import type { App } from '../../app/container.js';
import { runJig, type RunJigFailure, type RunReport } from '../../app/run-jig.js';
import type { RunStoreSetupInvalid } from '../../app/run-store-setup-invalid.js';
import { openRunStore } from '../../app/run-stores.js';
import { outcomeIsComplete } from '../../domain/invocation-status.js';
import { runIdFor } from '../../domain/run-id.js';
import { runBranchFor, type RunState } from '../../domain/run-state.js';
import { type GitCommandFailed, type RepositoryInvalid } from '../../ports/git-failures.js';
import type { RunStorePeekFailure } from '../../ports/run-store.js';
import { BaseBranchMismatch, GithubRefused, type PublicationInProgress } from './errors.js';
import { findingsCommentBody, stuckReason } from './findings-comment.js';
import type {
  GithubFailure,
  GithubPort,
  OpenPullRequest,
  RepositoryIdentity,
} from './github-port.js';
import {
  type AcceptedRequest,
  acceptedRequest,
  acceptRequest,
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
} from './orchestration-state.js';
import { OrchestrationStore, type StoreFailure, type WhileOwned } from './orchestration-store.js';
import { requestText } from './request-snapshot.js';
import {
  hasWorkBeyondStart,
  inspectRunBranch,
  type PublicationFailure as BranchPublicationFailure,
  publishRunBranch,
} from './run-branch-publication.js';

export type IssueOutcome =
  | { kind: 'pullRequest'; url: string; reused: boolean }
  | { kind: 'draftPullRequest'; url: string; reused: boolean; findingsUrl: string }
  | { kind: 'commented'; outcome: RunReport['status']; url: string }
  | { kind: 'refused'; paths: string[]; url: string };

type IssueFailure = RunJigFailure | RepositoryInvalid | BaseBranchMismatch | PublishOutcomeFailure;
type PublishOutcomeFailure =
  RunStorePeekFailure | RunStoreSetupInvalid | BranchPublicationFailure | PublicationFailure;

type PublicationFailure = GithubFailure | StoreFailure | PublicationInProgress;

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

type CodeCheckpoint = Pick<RunState, 'startingCommit' | 'codeRevision'>;

type Publication =
  { kind: 'comment'; revision?: string } | { kind: 'ready' | 'draft'; revision: string };

export function implementIssue(
  app: App,
  github: GithubPort,
  repository: RepositoryIdentity,
  issueNumber: number,
): Promise<Result<IssueOutcome, IssueFailure>> {
  return Result.gen(async function* () {
    app.cradle.logger.info(
      { event: 'githubIssuePreparationStarted', issueNumber, repository },
      `Checking GitHub issue #${issueNumber} in ${repository.owner}/${repository.repo}`,
    );
    const base = yield* Result.await(github.getDefaultBranch(repository));
    const current = yield* Result.await(getCurrentBranch(app.cradle.repoRoot));
    if (current !== base)
      return Result.err(
        new BaseBranchMismatch({
          message: `Check out the default branch "${base}" before implementing an issue (currently "${current}").`,
        }),
      );
    const store = new OrchestrationStore(app.cradle.repoRoot);
    const key = `${repository.owner}/${repository.repo}#${issueNumber}`;
    app.cradle.logger.info(
      { event: 'githubIssueRequestStarted', issueNumber },
      `Loading accepted request or fetching GitHub issue #${issueNumber}`,
    );
    const accepted = yield* Result.await(
      acceptedRequestFor(store, github, repository, key, issueNumber),
    );
    app.cradle.logger.info(
      { event: 'githubIssueRequestAccepted', issueNumber, runId: accepted.runId },
      `GitHub issue #${issueNumber} is ready as run ${accepted.runId}`,
    );
    const report = yield* Result.await(
      runJig(app, {
        start: { text: accepted.text, merge: false, codePublication: 'deferred' },
        runId: accepted.runId,
        requiredStores: REQUIRED_STORES,
      }),
    );
    app.cradle.logger.info(
      {
        event: 'githubIssueRunFinished',
        issueNumber,
        runId: accepted.runId,
        status: report.status,
      },
      `Run ${accepted.runId} finished ${report.status}; publishing the GitHub outcome`,
    );
    const target = { github, repository, issueNumber, key, base, title: accepted.title };
    return store.withPublicationOwnership(key, app.cradle.logger, (whileOwned) =>
      publishOutcome(app, store, { ...target, whileOwned }, report),
    );
  });
}

function acceptedRequestFor(
  store: OrchestrationStore,
  github: GithubPort,
  repository: RepositoryIdentity,
  key: string,
  issueNumber: number,
): Promise<Result<AcceptedRequest, GithubFailure | StoreFailure>> {
  return Result.gen(async function* () {
    const existing = yield* Result.await(store.read());
    const accepted = acceptedRequest(existing, key);
    if (accepted) return Result.ok(accepted);
    const issue = yield* Result.await(github.getIssue(repository, issueNumber));
    const state = yield* Result.await(
      store.update((state) =>
        acceptRequest(state, key, {
          runId: runIdFor({ name: issue.title, key }),
          title: issue.title,
          text: requestText(issue),
        }),
      ),
    );
    const request: AcceptedRequest | undefined = acceptedRequest(state, key);
    if (!request) panic('Accepting a request must preserve its snapshot');
    return Result.ok(request);
  });
}

/** Issue runs always keep their state on the remote, so a retried job on another clone resumes it. */
const REQUIRED_STORES = ['git-remote'];

/**
 * Publishes what the run left: a ready PR for a completed run with approved changes, a draft PR
 * with a findings comment for a stuck run that committed work, a refusal for one that changes a
 * workflow, and a status comment otherwise. Every run with code is inspected before any receipt is
 * reused, and its code reaches the remote only through `publishRunBranch`.
 */
function publishOutcome(
  app: App,
  store: OrchestrationStore,
  target: IssueTarget,
  report: RunReport,
): Promise<Result<IssueOutcome, PublishOutcomeFailure>> {
  return Result.gen(async function* () {
    const { repoRoot } = app.cradle;
    const checkpoint = yield* Result.await(codeCheckpointOf(app, report));
    const publication = yield* Result.await(publicationFor(repoRoot, report, checkpoint));
    if (publication.kind === 'comment')
      return publishStatus(repoRoot, store, target, { report, revision: publication.revision });
    const { revision } = publication;
    const pushed = yield* Result.await(
      target.whileOwned(() =>
        publishRunBranch(repoRoot, {
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
    const pullRequest = pullRequestFor(report, target, publication.kind === 'draft');
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
  app: App,
  report: RunReport,
): Promise<Result<CodeCheckpoint, RunStorePeekFailure | RunStoreSetupInvalid>> {
  return Result.gen(async function* () {
    const { runId } = report.state;
    const store = yield* Result.await(openRunStore(app.cradle, REQUIRED_STORES));
    const saved = yield* Result.await(store.peek(runId));
    if (saved?.codeRevision)
      return Result.ok({ startingCommit: saved.startingCommit, codeRevision: saved.codeRevision });
    const head = yield* Result.await(
      exactHead(app.cradle.repoRoot, `refs/heads/${runBranchFor(runId)}`),
    );
    return Result.ok({ codeRevision: head });
  });
}

/**
 * A completed run with code is offered as a ready PR and a stuck run with commits past where it
 * started as a draft; every other run, and one with no code, is reported in an issue comment.
 */
function publicationFor(
  repoRoot: string,
  report: RunReport,
  checkpoint: CodeCheckpoint,
): Promise<Result<Publication, GitCommandFailed>> {
  return Result.gen(async function* () {
    const revision = checkpoint.codeRevision;
    if (!revision) return Result.ok<Publication>({ kind: 'comment' });
    if (outcomeIsComplete(report.status))
      return Result.ok<Publication>({ kind: 'ready', revision });
    if (report.status !== 'stuck') return Result.ok<Publication>({ kind: 'comment', revision });
    const committed = yield* Result.await(hasWorkBeyondStart(repoRoot, checkpoint));
    return Result.ok<Publication>({ kind: committed ? 'draft' : 'comment', revision });
  });
}

function publishStatus(
  repoRoot: string,
  store: OrchestrationStore,
  target: IssueTarget,
  { report, revision }: { report: RunReport; revision?: string },
): Promise<Result<IssueOutcome, BranchPublicationFailure | PublicationFailure>> {
  return Result.gen(async function* () {
    if (!revision) return publishComment(store, target, { report });
    const { runId } = report.state;
    const inspection = yield* Result.await(
      inspectRunBranch(repoRoot, { runId, revision, defaultBranch: target.base }),
    );
    if (inspection.kind === 'refused')
      return refuse(store, target, { runId, revision, paths: inspection.paths });
    return publishComment(store, target, { report, revision });
  });
}

function publishComment(
  store: OrchestrationStore,
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
    save: (url: string) => Promise<Result<unknown, StoreFailure>>;
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

function statusCommentBody(report: RunReport): string {
  return `Run ${report.state.runId}: ${report.status}. ${statusCommentReason(report)}`;
}

function statusCommentReason(report: RunReport): string {
  switch (report.status) {
    case 'blocked':
      return report.reason;
    case 'halted':
      return 'Paused at the design checkpoint.';
    case 'stuck':
      return stuckReason(report.state);
    case 'completed':
    case 'done':
      return 'No changes were committed.';
  }
}

/** Records the refusal before announcing it, so a crash in between still never publishes the code. */
function refuse(
  store: OrchestrationStore,
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

function refusalCommentBody({ runId, revision, paths }: Refusal): string {
  const listed = paths.map((path) => `- \`${path}\``).join('\n');
  return `Run ${runId} was not published: revision ${revision} changes GitHub workflows, which jig does not push for review.\n\n${listed}`;
}

function pullRequestFor(
  report: RunReport,
  { title, issueNumber }: IssueTarget,
  draft: boolean,
): OpenPullRequest {
  return {
    head: runBranchFor(report.state.runId),
    base: report.state.baseBranch,
    title,
    body: `${report.state.prDescription ?? ''}\n\nCloses #${issueNumber}`,
    draft,
  };
}

function publishReady(
  store: OrchestrationStore,
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
  store: OrchestrationStore,
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
  store: OrchestrationStore,
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
