import { TaggedError } from 'better-result';

/** The remote copy of a run moved in a way this process cannot follow without losing someone's work. */
export class RunStateConflict extends TaggedError('RunStateConflict')<{ message: string }> {
  readonly kind = 'block' as const;
}

/**
 * A saved run names a code checkpoint this machine cannot produce: the commit is neither kept here
 * nor published on the remote, so resuming would continue from code the state does not describe.
 */
export class RunCodeUnavailable extends TaggedError('RunCodeUnavailable')<{ message: string }> {
  readonly kind = 'block' as const;
}

/** Another jig process is already running this run; two writers would overwrite each other. */
export class RunInProgress extends TaggedError('RunInProgress')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** Keeps the legacy `ConfigInvalid` serialized/log tag and fatal classification; never dispatch on the tag. */
export class RunStateInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** Keeps the legacy `ConfigInvalid` serialized/log tag and fatal classification; never dispatch on the tag. */
export class RunStoreFailed extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
