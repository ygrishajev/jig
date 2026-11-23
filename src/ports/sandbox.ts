import { TaggedError } from 'better-result';

import type { CodexLoginNotSaved, CredentialsInvalid } from './credentials.js';
import type { FilesystemPreparationFailed } from './filesystem.js';

export type SessionOpenFailure =
  | SandboxPreparationFailed
  | SandboxUnavailable
  | SetupCommandFailed
  | CredentialsInvalid
  | FilesystemPreparationFailed;
export type SessionCloseFailure = SandboxUnavailable | CodexLoginNotSaved;

export class SandboxUnavailable extends TaggedError('SandboxUnavailable')<{ message: string }> {
  readonly kind = 'retry' as const;
}

export class SetupCommandFailed extends TaggedError('SetupCommandFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'retry' as const;
}

export class ImageBuildFailed extends TaggedError('ImageBuildFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'fatal' as const;
}

export class SandboxPreparationFailed extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

export class ImageRecipeInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
