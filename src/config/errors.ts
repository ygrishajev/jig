import { TaggedError } from 'better-result';

export class ConfigInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
