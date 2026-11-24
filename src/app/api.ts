import type { Result } from 'better-result';

import type { Preset } from '../config/presets.js';
import type { BuildImageFailure, BuildImageInput, SandboxImageReport } from './build-image.js';
import type { InitFailure, InitInput, InitReport } from './init-sandbox.js';
import type { PresetListingFailure } from './list-presets.js';
import type { RunReport } from './run-jig.js';
import type { RunFailure, RunInput } from './run-operation.js';
import type { RunStatus, RunStatusFailure, StatusInput } from './run-status.js';

/**
 * The operations a caller such as the CLI is handed, already bound to their capabilities. Each
 * checks the repository and reads the settings it needs itself, so no caller repeats them.
 */
export interface JigOperations {
  run(input: RunInput): Promise<Result<RunReport, RunFailure>>;
  status(input: StatusInput): Promise<Result<RunStatus, RunStatusFailure>>;
  listPresets(): Promise<Result<Preset[], PresetListingFailure>>;
  init(input: InitInput): Promise<Result<InitReport, InitFailure>>;
  buildImage(input: BuildImageInput): Promise<Result<SandboxImageReport, BuildImageFailure>>;
}

export type { Preset, PresetPick, PresetSelection } from '../config/presets.js';
export type { MetricsSummary, RunDocumentFile } from '../ports/run-records.js';
export {
  type BuildImageCapabilities,
  type BuildImageFailure,
  type BuildImageInput,
  buildSandboxImage,
  type SandboxImageReport,
} from './build-image.js';
export {
  type InitCapabilities,
  type InitFailure,
  type InitInput,
  type InitInteraction,
  type InitReport,
  initRepository,
  type InitResult,
  type SandboxCheckFailure,
} from './init-sandbox.js';
export {
  listPresets,
  type PresetListingCapabilities,
  type PresetListingFailure,
} from './list-presets.js';
export type {
  EnvironmentVariables,
  OperationContext,
  PresetPlaces,
  RepositoryPreparationFailure,
  RepositorySources,
} from './repository-preparation.js';
export type {
  RunCapabilities,
  RunLog,
  RunReport,
  RunSandbox,
  RunScope,
  StartingPoint,
  StartRequest,
} from './run-jig.js';
export {
  type RunFailure,
  type RunInput,
  type RunOperationCapabilities,
  type RunRequest,
  type RunRuntime,
  type RuntimeRequest,
  startOrResumeRun,
} from './run-operation.js';
export type {
  AgentCredentials,
  SandboxCapabilities,
  SandboxOperationCapabilities,
  SandboxRuntime,
  SandboxSettings,
} from './sandbox-runtime.js';
export type { EnsureImageDependencies } from './sandbox-image.js';
export type { ThrowawaySandboxes, ThrowawaySandboxFailure } from './throwaway-sandbox.js';
export {
  readRunStatus,
  type RunStatus,
  type RunStatusFailure,
  type StatusCapabilities,
  type StatusInput,
} from './run-status.js';
