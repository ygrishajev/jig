import type { Result } from 'better-result';

import type { MissingCredential } from '../config/agent-policy.js';
import type { JigEnvironment } from '../config/environment.js';
import type { ConfigInvalid } from '../config/errors.js';
import type { JigConfig, StepConfig } from '../config/load-config.js';
import type {
  SandboxCredentialsInvalid,
  SandboxPreparationInvalid,
  SandboxUnavailable,
  SetupCommandFailed,
} from '../ports/agent-session.js';
import type { LocalPreparationFailed, LocalStateUnwritable } from '../ports/local-state.js';
import type { OperationLog } from '../ports/observability.js';
import type { StarterFiles } from '../ports/starter-files.js';
import type { OperationContext, RepositorySources } from './repository-preparation.js';
import type { RuntimeRequest } from './run-operation.js';
import type { EnsureImageDependencies } from './sandbox-image.js';
import type { ThrowawaySandboxes } from './throwaway-sandbox.js';

/** What an operation that builds the sandbox image, or checks the repository in one, is bound to. */
export interface SandboxOperationCapabilities extends RepositorySources {
  context(): OperationContext;
  /** Builds what the operation works with once the repository and its config are known. */
  openSandboxRuntime(request: RuntimeRequest): SandboxRuntime;
}

/** What image and sandbox checks work with, and how to release what was built for them. */
export interface SandboxRuntime {
  readonly log: OperationLog;
  readonly starterFiles: StarterFiles;
  readonly credentials: AgentCredentials;
  /** The image and throwaway sandboxes for the agents and credentials these settings name. */
  sandboxFor(settings: SandboxSettings): SandboxCapabilities;
  dispose(): Promise<void>;
}

/** Which credentials the configured agents need, and where an entered one is kept. */
export interface AgentCredentials {
  missing(
    steps: StepConfig[],
    environment: JigEnvironment,
  ): Result<MissingCredential[], ConfigInvalid>;
  /** Fails, naming what to set, when a step's agent has no credential or one that cannot work. */
  check(
    steps: StepConfig[],
    environment: JigEnvironment,
  ): Result<void, ConfigInvalid | SandboxCredentialsInvalid>;
  /** Keeps the credential for later runs, readable only by the operator and ignored by git. */
  save(credential: {
    name: string;
    value: string;
  }): Promise<Result<void, LocalPreparationFailed | LocalStateUnwritable>>;
}

export interface SandboxSettings {
  config: JigConfig;
  environment: JigEnvironment;
}

export interface SandboxCapabilities {
  readonly image: EnsureImageDependencies;
  readonly throwaway: ThrowawaySandboxes;
}

/**
 * Why a sandbox did not open, named by the app so its contracts carry no adapter type. The
 * configuration, credential, preparation and local file failures are the operator's to fix.
 */
export type SandboxOpenFailure =
  | ConfigInvalid
  | SandboxCredentialsInvalid
  | SandboxPreparationInvalid
  | LocalPreparationFailed
  | SandboxUnavailable
  | SetupCommandFailed;
