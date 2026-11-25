import { TaggedError } from 'better-result';

/** The remote copy of a run moved in a way this process cannot follow without losing someone's work. */
export class RunStateConflict extends TaggedError('RunStateConflict')<{ message: string }> {}

/**
 * A saved run names a code checkpoint this machine cannot produce: the commit is neither kept here
 * nor published on the remote, so resuming would continue from code the state does not describe.
 */
export class RunCodeUnavailable extends TaggedError('RunCodeUnavailable')<{ message: string }> {}

/** A saved run, read back from a store, does not parse as run state. */
export class RunStateInvalid extends TaggedError('RunStateInvalid')<{ message: string }> {}

/** Another jig process is already running this run; two writers would overwrite each other. */
export class RunInProgress extends TaggedError('RunInProgress')<{ message: string }> {}

/** A complete line of a run's metrics log is not a metric record: the file was edited or damaged. */
export class MetricsLogCorrupt extends TaggedError('MetricsLogCorrupt')<{ message: string }> {}
