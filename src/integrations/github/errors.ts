import { TaggedError } from 'better-result';

export type GithubError =
  | GithubUnavailable
  | GithubRefused
  | GithubNotFound
  | GithubSetupInvalid
  | BaseBranchMismatch
  | OrchestrationStateInvalid;

export class GithubUnavailable extends TaggedError('GithubUnavailable')<{ message: string }> {}
export class GithubRefused extends TaggedError('GithubRefused')<{ message: string }> {}
export class GithubNotFound extends TaggedError('GithubNotFound')<{ message: string }> {}
export class GithubSetupInvalid extends TaggedError('GithubSetupInvalid')<{ message: string }> {}
export class BaseBranchMismatch extends TaggedError('BaseBranchMismatch')<{ message: string }> {}
export class OrchestrationStateInvalid extends TaggedError('OrchestrationStateInvalid')<{
  message: string;
}> {}
