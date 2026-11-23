import { TaggedError } from 'better-result';

export class MetricsLogCorrupt extends TaggedError('MetricsLogCorrupt')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
