import { Result } from 'better-result';

import type { LogFormat } from '../adapters/logging/create-logger.js';
import type { ConfigSource } from '../config/config-source.js';
import type { JigEnvironment } from '../config/environment.js';
import type { ConfigInvalid } from '../config/errors.js';
import type { JigConfig } from '../config/load-config.js';
import type { PresetSource } from '../config/preset-source.js';
import type { PresetSelection } from '../config/presets.js';
import type { RunId } from '../domain/run-id.js';
import { disposableLifetime, withResource } from './lifecycle.js';
import { prepareWithPreset, type PresetPreparation } from './preset-selection.js';
import type { RepositoryPreparationFailure } from './repository-preparation.js';
import {
  type RunCapabilities,
  runJig,
  type RunJigFailure,
  type RunReport,
  type StartRequest,
} from './run-jig.js';

export interface RunInput {
  run: RunRequest;
  /** A config file other than the repository's own, relative to its root. */
  configPath?: string;
  preset?: PresetSelection;
  logFormat: LogFormat;
}

/** A run to start from a request, named by `runId` when given, or the run `resume` to carry on. */
export type RunRequest =
  { start: Omit<StartRequest, 'codePublication'>; runId?: RunId } | { resume: RunId };

export type RunFailure = RepositoryPreparationFailure | ConfigInvalid | RunJigFailure;

export interface RunOperationCapabilities extends PresetPreparation {
  /** Builds what the run works with once the repository and its config are known. */
  openRuntime(request: RuntimeRequest): RunRuntime;
}

/** A repository prepared for a run, with the preset it was asked for applied. */
export interface RuntimeRequest {
  repoRoot: string;
  logFormat: LogFormat;
  environment: JigEnvironment;
  configPath?: string;
  configSource: ConfigSource;
  config: JigConfig;
  presetSource: PresetSource;
}

/** The capabilities a run works with, and how to release what was built for them. */
export interface RunRuntime {
  readonly run: RunCapabilities;
  dispose(): Promise<void>;
}

/**
 * Starts or resumes a run in the repository the caller is in. The repository, its environment,
 * saved credentials and config are prepared and the preset chosen before anything is built, so a
 * refusal there starts no sandbox; what was built is released once the run stops, however it stops.
 */
export function startOrResumeRun(
  capabilities: RunOperationCapabilities,
  { run, configPath, preset, logFormat }: RunInput,
): Promise<Result<RunReport, RunFailure>> {
  return Result.gen(async function* () {
    const { repository, presetName } = yield* Result.await(
      prepareWithPreset(capabilities, { configPath, preset }),
    );
    const runtime = capabilities.openRuntime({ ...repository, configPath, logFormat });
    return await withResource(disposableLifetime(runtime), runtime.run.log, (opened) => {
      if (presetName !== undefined) {
        opened.run.log.info({ preset: presetName }, `Using preset ${presetName}`);
      }
      return runJig(opened.run, run);
    });
  });
}
