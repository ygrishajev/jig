import { TaggedError } from 'better-result';

/**
 * The Codex login a run refreshed could not be handed back to the operator's own login, or its
 * lock could not be let go; the run's work is unaffected.
 */
export class CodexLoginNotSaved extends TaggedError('CodexLoginNotSaved')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** Keeps the legacy `ConfigInvalid` serialized/log tag and fatal classification; never dispatch on the tag. */
export class CredentialsInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
