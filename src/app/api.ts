import type { Result } from 'better-result';

import type { Preset } from '../config/presets.js';
import type { PresetListingFailure } from './list-presets.js';
import type { RunStatus, RunStatusFailure, StatusInput } from './run-status.js';

/**
 * The operations a caller such as the CLI is handed, already bound to their capabilities. Each
 * checks the repository and reads the settings it needs itself, so no caller repeats them.
 */
export interface JigOperations {
  status(input: StatusInput): Promise<Result<RunStatus, RunStatusFailure>>;
  listPresets(): Promise<Result<Preset[], PresetListingFailure>>;
}

export type { Preset } from '../config/presets.js';
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
export {
  readRunStatus,
  type RunStatus,
  type RunStatusFailure,
  type StatusCapabilities,
  type StatusInput,
} from './run-status.js';
