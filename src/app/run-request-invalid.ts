import { TaggedError } from 'better-result';

export class RunRequestInvalid extends TaggedError('RunRequestInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
