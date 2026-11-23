import { TaggedError } from 'better-result';

export class CodexLoginNotSaved extends TaggedError('CodexLoginNotSaved')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

export class CredentialsInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
