import { TaggedError } from 'better-result';

/** A complete line of a run's metrics log is not a metric record: the file was edited or damaged. */
export class MetricsLogCorrupt extends TaggedError('MetricsLogCorrupt')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
