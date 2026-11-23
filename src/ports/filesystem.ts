import { TaggedError } from 'better-result';

export class LocalStateUnwritable extends TaggedError('LocalStateUnwritable')<{
  message: string;
  path: string;
}> {
  readonly kind = 'fatal' as const;
}

export class FilesystemPreparationFailed extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
