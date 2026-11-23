import { TaggedError } from 'better-result';

export class RunStateConflict extends TaggedError('RunStateConflict')<{ message: string }> {
  readonly kind = 'block' as const;
}

export class RunCodeUnavailable extends TaggedError('RunCodeUnavailable')<{ message: string }> {
  readonly kind = 'block' as const;
}

export class RunInProgress extends TaggedError('RunInProgress')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

export class RunStateInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

export class RunStoreFailed extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
