import { TaggedError } from 'better-result';

/** The request a run is asked to start from, or the run asked about, cannot be used. */
export class RunRequestInvalid extends TaggedError('RunRequestInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
