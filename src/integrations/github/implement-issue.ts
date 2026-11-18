import { panic, Result } from 'better-result';

import { getCurrentBranch } from '../../adapters/git/branch.js';
import { exactHead } from '../../adapters/git/run-history.js';
import type { App } from '../../app/container.js';
import { runJig, type RunReport } from '../../app/run-jig.js';
import { openRunStore } from '../../app/run-stores.js';
import type { JigError } from '../../domain/errors.js';
import { runIdFor } from '../../domain/run-id.js';
import { runBranchFor, runStopReason } from '../../domain/run-state.js';
import { outcomeIsComplete } from '../../flow/engine.js';
import { BaseBranchMismatch, type GithubError, type GithubSetupInvalid } from './errors.js';
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
  pullRequestReceipt,
  type Refusal,
  refusalCommentReceipt,
  refusalMarker,
  refusalOf,
  withComment,
  withPullRequest,
  withRefusal,
  withRefusalComment,
} from './orchestration-state.js';
import { OrchestrationStore, type StoreFailure } from './orchestration-store.js';
import { requestText } from './request-snapshot.js';
import { publishRunBranch } from './run-branch-publication.js';

export type IssueOutcome =
  | { kind: 'pullRequest'; url: string; reused: boolean }
  | { kind: 'commented'; outcome: RunReport['status']; url: string }
  | { kind: 'refused'; paths: string[]; url: string };

type IssueFailure = JigError | Exclude<GithubError, GithubSetupInvalid>;

/** Where the accepted request is published: the issue, its key in the receipts, and its default branch. */
interface IssueTarget {
  github: GithubPort;
  repository: RepositoryIdentity;
  issueNumber: number;
  key: string;
  base: string;
  title: string;
}

export function implementIssue(
  app: App,
  github: GithubPort,
  repository: RepositoryIdentity,
  issueNumber: number,
): Promise<Result<IssueOutcome, IssueFailure>> {
  return Result.gen(async function* () {
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
    const accepted = yield* Result.await(
      acceptedRequestFor(store, github, repository, key, issueNumber),
    );
    const report = yield* Result.await(
      runJig(app, {
        start: { text: accepted.text, merge: false, codePublication: 'deferred' },
        runId: accepted.runId,
        requiredStores: REQUIRED_STORES,
      }),
    );
    const target = { github, repository, issueNumber, key, base, title: accepted.title };
    return store.withPublicationOwnership(key, app.cradle.logger, () =>
      publishOutcome(app, store, target, report),
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
 * Publishes what the run left: a PR for a completed run with approved changes, a refusal for one
 * that changes a workflow, and a status comment otherwise. Code reaches the remote only through
 * `publishRunBranch`, which inspects it before any receipt is reused.
 */
function publishOutcome(
  app: App,
  store: OrchestrationStore,
  target: IssueTarget,
  report: RunReport,
): Promise<Result<IssueOutcome, IssueFailure>> {
  return Result.gen(async function* () {
    const { repoRoot } = app.cradle;
    const revision = yield* Result.await(codeRevisionOf(app, report));
    if (!revision || !outcomeIsComplete(report.status))
      return publishComment(store, target, { report, revision });
    const publication = yield* Result.await(
      publishRunBranch(repoRoot, {
        runId: report.state.runId,
        revision,
        defaultBranch: target.base,
      }),
    );
    if (publication.kind === 'refused')
      return refuse(store, target, {
        runId: report.state.runId,
        revision,
        paths: publication.paths,
      });
    if (publication.kind === 'unchanged')
      return publishComment(store, target, { report, revision });
    return publish(store, target, pullRequestFor(report, target));
  });
}

/**
 * The code checkpoint the run's saved state records, which the run branch must still hold. A run
 * saved before checkpoints were recorded has none, so its branch here is what gets inspected.
 */
function codeRevisionOf(
  app: App,
  report: RunReport,
): Promise<Result<string | undefined, JigError>> {
  return Result.gen(async function* () {
    const { runId } = report.state;
    const store = yield* Result.await(openRunStore(app.cradle, REQUIRED_STORES));
    const saved = yield* Result.await(store.peek(runId));
    if (saved?.codeRevision) return Result.ok(saved.codeRevision);
    return exactHead(app.cradle.repoRoot, `refs/heads/${runBranchFor(runId)}`);
  });
}

function publishComment(
  store: OrchestrationStore,
  target: IssueTarget,
  { report, revision }: { report: RunReport; revision?: string },
): Promise<Result<IssueOutcome, GithubFailure | StoreFailure>> {
  return Result.gen(async function* () {
    const identity = {
      runId: report.state.runId,
      outcome: report.status,
      revision: revision ?? NO_CODE_REVISION,
    };
    const state = yield* Result.await(store.read());
    const url = yield* Result.await(
      commentOnce(target, {
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
 * Posts a comment at most once: a saved receipt is reused, and a comment posted before its receipt
 * was saved is found again by its marker instead of being posted a second time.
 */
function commentOnce(
  { github, repository, issueNumber }: IssueTarget,
  comment: {
    receipt: string | undefined;
    marker: string;
    body: string;
    save: (url: string) => Promise<Result<unknown, StoreFailure>>;
  },
): Promise<Result<string, GithubFailure | StoreFailure>> {
  return Result.gen(async function* () {
    if (comment.receipt) return Result.ok(comment.receipt);
    const found = yield* Result.await(
      github.findIssueComment(repository, issueNumber, comment.marker),
    );
    const url =
      found ??
      (yield* Result.await(
        github.commentOnIssue(repository, issueNumber, `${comment.body}\n\n${comment.marker}`),
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
      return runStopReason(report.state) ?? 'The run exhausted its attempts.';
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
): Promise<Result<IssueOutcome, GithubFailure | StoreFailure>> {
  return Result.gen(async function* () {
    const { key } = target;
    const state = yield* Result.await(store.update((state) => withRefusal(state, key, refusal)));
    const recorded = refusalOf(state, key, refusal.revision) ?? refusal;
    const url = yield* Result.await(
      commentOnce(target, {
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

function publish(
  store: OrchestrationStore,
  { github, repository, key }: IssueTarget,
  publication: OpenPullRequest,
): Promise<Result<IssueOutcome, GithubFailure | StoreFailure>> {
  return Result.gen(async function* () {
    const state = yield* Result.await(store.read());
    const receipt = pullRequestReceipt(state, key);
    if (receipt)
      return Result.ok<IssueOutcome>({ kind: 'pullRequest', url: receipt.url, reused: true });
    const found = yield* Result.await(
      github.findOpenPullRequestByHead(repository, publication.head),
    );
    const pr = found ?? (yield* Result.await(github.openPullRequest(repository, publication)));
    yield* Result.await(store.update((state) => withPullRequest(state, key, pr)));
    return Result.ok<IssueOutcome>({ kind: 'pullRequest', url: pr.url, reused: !!found });
  });
}

function pullRequestFor(report: RunReport, { title, issueNumber }: IssueTarget): OpenPullRequest {
  return {
    head: runBranchFor(report.state.runId),
    base: report.state.baseBranch,
    title,
    body: `${report.state.prDescription ?? ''}\n\nCloses #${issueNumber}`,
    draft: false,
  };
}
