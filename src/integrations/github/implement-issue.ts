import { panic, Result } from 'better-result';

import { getCurrentBranch } from '../../adapters/git/branch.js';
import { RemoteRef } from '../../adapters/git/remote-ref.js';
import { hasChangesAgainst } from '../../adapters/git/repository.js';
import type { App } from '../../app/container.js';
import { runJig, type RunReport } from '../../app/run-jig.js';
import { type JigError, RemoteUnavailable } from '../../domain/errors.js';
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
  commentReceipt,
  pullRequestReceipt,
  withComment,
  withPullRequest,
} from './orchestration-state.js';
import { OrchestrationStore, type StoreFailure } from './orchestration-store.js';
import { requestText } from './request-snapshot.js';

export type IssueOutcome =
  | { kind: 'pullRequest'; url: string; reused: boolean }
  | { kind: 'commented'; outcome: RunReport['status']; url: string };

export function implementIssue(
  app: App,
  github: GithubPort,
  repository: RepositoryIdentity,
  issueNumber: number,
): Promise<Result<IssueOutcome, JigError | Exclude<GithubError, GithubSetupInvalid>>> {
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
        start: { text: accepted.text, merge: false },
        runId: accepted.runId,
        requiredStores: ['git-remote'],
      }),
    );
    const changes = yield* Result.await(
      hasChangesAgainst(app.cradle.repoRoot, base, runBranchFor(accepted.runId)),
    );
    const publication = publicationFor(report, { title: accepted.title, issueNumber, changes });
    const refs = new RemoteRef(app.cradle.repoRoot);
    const branch = `refs/heads/${runBranchFor(accepted.runId)}`;
    const listed = yield* Result.await(refs.list([branch]));
    const revision = listed.get(branch);
    if (!revision)
      return Result.err(
        new RemoteUnavailable({ message: `Run branch ${branch} is missing on origin.` }),
      );
    if (publication)
      return Result.ok(yield* Result.await(publish(store, github, repository, key, publication)));
    return Result.ok(
      yield* Result.await(
        publishComment(store, github, repository, issueNumber, { report, revision }),
      ),
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

export function publicationFor(
  report: RunReport,
  { title, issueNumber, changes }: { title: string; issueNumber: number; changes: boolean },
): OpenPullRequest | undefined {
  if (!changes || !outcomeIsComplete(report.status)) return undefined;
  return {
    head: runBranchFor(report.state.runId),
    base: report.state.baseBranch,
    title,
    body: `${report.state.prDescription ?? ''}\n\nCloses #${issueNumber}`,
    draft: false,
  };
}

function publish(
  store: OrchestrationStore,
  github: GithubPort,
  repository: RepositoryIdentity,
  key: string,
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

function publishComment(
  store: OrchestrationStore,
  github: GithubPort,
  repository: RepositoryIdentity,
  issueNumber: number,
  { report, revision }: { report: RunReport; revision: string },
): Promise<Result<IssueOutcome, GithubFailure | StoreFailure>> {
  return Result.gen(async function* () {
    const identity = { runId: report.state.runId, outcome: report.status, revision };
    const state = yield* Result.await(store.read());
    let url = commentReceipt(state, identity);
    if (!url) {
      const body = statusCommentBody(report);
      const postedUrl = yield* Result.await(github.commentOnIssue(repository, issueNumber, body));
      yield* Result.await(store.update((state) => withComment(state, identity, postedUrl)));
      url = postedUrl;
    }
    return Result.ok<IssueOutcome>({ kind: 'commented', outcome: report.status, url });
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
