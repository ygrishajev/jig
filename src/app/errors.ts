import { TaggedError } from 'better-result';

/** The request a run is asked to start from, or the run asked about, cannot be used. */
export class RunRequestInvalid extends TaggedError('RunRequestInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** The clone is not on the repository's default branch, which an issue run must start from. */
export class BaseBranchMismatch extends TaggedError('BaseBranchMismatch')<{ message: string }> {}
