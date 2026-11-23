import { TaggedError } from 'better-result';

export class RemoteUnavailable extends TaggedError('RemoteUnavailable')<{ message: string }> {
  readonly kind = 'retry' as const;
}

export class GitCommandFailed extends TaggedError('GitCommandFailed')<{
  message: string;
  command: string;
  output: string;
}> {
  readonly kind = 'block' as const;
}

export class RepositoryInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
