import { TaggedError } from 'better-result';

/** Keeps the legacy `ConfigInvalid` serialized/log tag and fatal classification; never dispatch on the tag. */
export class RunStoreSetupInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
