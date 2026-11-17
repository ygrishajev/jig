import { Result } from 'better-result';

import { getCurrentBranch } from '../../adapters/git/branch.js';
import { hasChangesAgainst } from '../../adapters/git/repository.js';
import type { App } from '../../app/container.js';
import { runJig, type RunReport } from '../../app/run-jig.js';
import type { JigError } from '../../domain/errors.js';
import { runIdFor } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import { BaseBranchMismatch, type GithubError } from './errors.js';
import type { GithubPort, OpenPullRequest, RepositoryIdentity } from './github-port.js';
import {
  acceptRequest,
  hasCommented,
  pullRequestReceipt,
  withComment,
  withPullRequest,
} from './orchestration-state.js';
import { OrchestrationStore } from './orchestration-store.js';
import { requestText } from './request-snapshot.js';

export function implementIssue(
  app: App,
  github: GithubPort,
  repository: RepositoryIdentity,
  issueNumber: number,
): Promise<Result<void, JigError | GithubError>> {
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
    const existing = yield* Result.await(store.read());
    let accepted = existing.requests[key];
    if (!accepted) {
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
      accepted = state.requests[key];
    }
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
    if (!publication) return Result.ok();
    let state = yield* Result.await(store.read());
    let receipt = pullRequestReceipt(state, key);
    if (!receipt) {
      const found = yield* Result.await(
        github.findOpenPullRequestByHead(repository, publication.head),
      );
      const pr = found ?? (yield* Result.await(github.openPullRequest(repository, publication)));
      state = yield* Result.await(store.update((state) => withPullRequest(state, key, pr)));
      receipt = pullRequestReceipt(state, key);
    }
    if (receipt && !hasCommented(state, key)) {
      yield* Result.await(
        github.commentOnIssue(repository, issueNumber, `Implementation: ${receipt.url}`),
      );
      yield* Result.await(store.update((state) => withComment(state, key)));
    }
    return Result.ok();
  });
}

export function publicationFor(
  report: RunReport,
  { title, issueNumber, changes }: { title: string; issueNumber: number; changes: boolean },
): OpenPullRequest | undefined {
  if (!changes || report.status === 'halted') return undefined;
  const completed = report.status === 'completed' || report.status === 'done';
  const summary =
    report.status === 'blocked'
      ? report.reason
      : `Run ${report.state.runId} stopped with status ${report.status}.`;
  return {
    head: runBranchFor(report.state.runId),
    base: report.state.baseBranch,
    title,
    body: `${report.state.prDescription ?? summary}\n\n${completed ? 'Closes' : 'Refs'} #${issueNumber}`,
    draft: !completed,
  };
}
