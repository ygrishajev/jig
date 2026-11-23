import { TaggedError } from 'better-result';

export class RunStoreSetupInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
