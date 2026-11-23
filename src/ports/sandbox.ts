import { TaggedError } from 'better-result';

import type { CodexLoginNotSaved, CredentialsInvalid } from './credentials.js';
import type { FilesystemPreparationFailed } from './filesystem.js';

/** Why a sandbox did not open; preparation failures need an operator, while transient failures may pass. */
export type SessionOpenFailure =
  | SandboxPreparationFailed
  | SandboxUnavailable
  | SetupCommandFailed
  | CredentialsInvalid
  | FilesystemPreparationFailed;
/** Why a sandbox did not close cleanly: the container would not stop, or the login was not handed back. */
export type SessionCloseFailure = SandboxUnavailable | CodexLoginNotSaved;

/**
 * The sandbox did not start: the Docker daemon, a container start, or creating the worktree
 * failed in a way sandcastle does not tell apart from a passing hiccup, so it is worth another go.
 */
export class SandboxUnavailable extends TaggedError('SandboxUnavailable')<{ message: string }> {
  readonly kind = 'retry' as const;
}

/**
 * The setup command exited non-zero or outlived its timeout. It is the project's toolchain, so
 * `init` hands it back to the planner; in a run it is retried, since `npm ci` fails on a network
 * blip as readily as on a broken lockfile.
 */
export class SetupCommandFailed extends TaggedError('SetupCommandFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'retry' as const;
}

/** A sandbox image could not be built, or docker could not be asked about one; `output` is what docker said. */
export class ImageBuildFailed extends TaggedError('ImageBuildFailed')<{
  message: string;
  output: string;
}> {
  readonly kind = 'fatal' as const;
}

/** Keeps the legacy `ConfigInvalid` serialized/log tag and fatal classification; never dispatch on the tag. */
export class SandboxPreparationFailed extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}

/** Keeps the legacy `ConfigInvalid` serialized/log tag and fatal classification; never dispatch on the tag. */
export class ImageRecipeInvalid extends TaggedError('ConfigInvalid')<{ message: string }> {
  readonly kind = 'fatal' as const;
}
