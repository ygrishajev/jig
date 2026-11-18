import { TaggedError } from 'better-result';

export type GithubError =
  | GithubUnavailable
  | GithubRefused
  | GithubNotFound
  | GithubSetupInvalid
  | BaseBranchMismatch
  | OrchestrationStateInvalid
  | PublicationInProgress
  | RunBranchUnpublishable;

export class GithubUnavailable extends TaggedError('GithubUnavailable')<{ message: string }> {}
export class GithubRefused extends TaggedError('GithubRefused')<{ message: string }> {}
export class GithubNotFound extends TaggedError('GithubNotFound')<{ message: string }> {}
export class GithubSetupInvalid extends TaggedError('GithubSetupInvalid')<{ message: string }> {}
export class BaseBranchMismatch extends TaggedError('BaseBranchMismatch')<{ message: string }> {}
export class OrchestrationStateInvalid extends TaggedError('OrchestrationStateInvalid')<{
  message: string;
}> {}
/** Another job holds the lease to publish the same accepted request. */
export class PublicationInProgress extends TaggedError('PublicationInProgress')<{
  message: string;
}> {}
/** The run branch could not be inspected, or moved away from what was inspected, so nothing was pushed. */
export class RunBranchUnpublishable extends TaggedError('RunBranchUnpublishable')<{
  message: string;
}> {}
