import { panic, Result } from 'better-result';

import { type AcceptedRequest, acceptedRequest, acceptRequest } from '../domain/orchestration.js';
import type { RepositoryIdentity } from '../domain/repository-identity.js';
import { runIdFor } from '../domain/run-id.js';
import type { GithubFailure, GithubPort, Issue } from '../ports/github.js';
import type { ReceiptStore, ReceiptStoreFailure } from '../ports/publication-receipts.js';

/** The issue a request is accepted from, and its key in the shared receipts. */
export interface RequestSource {
  github: GithubPort;
  repository: RepositoryIdentity;
  issueNumber: number;
  key: string;
}

/**
 * The request the issue was accepted as. Once accepted, its snapshot and run id are reused as
 * saved, so an issue edited later neither changes the run nor starts another.
 */
export function acceptedRequestFor(
  receipts: ReceiptStore,
  { github, repository, issueNumber, key }: RequestSource,
): Promise<Result<AcceptedRequest, GithubFailure | ReceiptStoreFailure>> {
  return Result.gen(async function* () {
    const existing = yield* Result.await(receipts.read());
    const accepted = acceptedRequest(existing, key);
    if (accepted) return Result.ok(accepted);
    const issue = yield* Result.await(github.getIssue(repository, issueNumber));
    const state = yield* Result.await(
      receipts.update((state) =>
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

export function requestText(issue: Issue): string {
  return `# ${issue.title}\n\n${issue.body}\n\nSource: ${issue.url}\n`;
}
