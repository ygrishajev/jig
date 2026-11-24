import { TaggedError } from 'better-result';

import type {
  OrchestrationStateInvalid,
  PublicationInProgress,
} from '../../ports/publication-receipts.js';

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
/** The run branch could not be inspected, or moved away from what was inspected, so nothing was pushed. */
export class RunBranchUnpublishable extends TaggedError('RunBranchUnpublishable')<{
  message: string;
}> {}
