import type { Result } from 'better-result';

import type { Preset } from '../config/presets.js';
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
}

export type { Preset, PresetPick, PresetSelection } from '../config/presets.js';
export type { MetricsSummary, RunDocumentFile } from '../ports/run-records.js';
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
export {
  readRunStatus,
  type RunStatus,
  type RunStatusFailure,
  type StatusCapabilities,
  type StatusInput,
} from './run-status.js';
