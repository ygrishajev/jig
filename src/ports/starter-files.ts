import type { Result } from 'better-result';

import type { SandboxPreparationInvalid } from './agent-session.js';
import type { LocalPreparationFailed } from './local-state.js';

/**
 * The files `jig init` writes into the operator's tree for them to review and commit: the
 * sandbox Dockerfile, with the ignore rules for sandbox scratch beside it, and a starter config.
 */
export interface StarterFiles {
  /** Writes each file the repository lacks and refuses to write through a link. */
  writeMissing(): Promise<Result<void, LocalPreparationFailed | SandboxPreparationInvalid>>;
  readDockerfile(): Promise<Result<string, SandboxPreparationInvalid>>;
  /** Replaces the project toolchain section of the Dockerfile. */
  writeToolchain(
    toolchain: string,
  ): Promise<Result<void, SandboxPreparationInvalid | LocalPreparationFailed>>;
}
