import { TaggedError } from 'better-result';

/** A fetch or push to the remote failed; the network may well be back on the next attempt. */
export class RemoteUnavailable extends TaggedError('RemoteUnavailable')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/**
 * A git command failed for a reason the operator has to look at: a missing ref, a broken
 * repository. `command` is what was run; `output` is what it printed, or why it could not run.
 */
export class GitCommandFailed extends TaggedError('GitCommandFailed')<{
  message: string;
  command: string;
  output: string;
}> {
  readonly kind = 'block' as const;
}

/** Keeps the legacy `ConfigInvalid` serialized/log tag and fatal classification; never dispatch on the tag. */
export class RepositoryInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
