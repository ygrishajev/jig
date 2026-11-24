import { Result } from 'better-result';

import type { ConfigInvalid } from '../config/errors.js';
import type { PresetSelection } from '../config/presets.js';
import type { SandboxPreparationInvalid } from '../ports/agent-session.js';
import type { LogFormat } from '../ports/observability.js';
import type { ImageBuildFailed } from '../ports/sandbox-images.js';
import { disposableLifetime, withResource } from './lifecycle.js';
import { prepareWithPreset, type PresetChooser } from './preset-selection.js';
import type { RepositoryPreparationFailure } from './repository-preparation.js';
import { ensureSandboxImage } from './sandbox-image.js';
import type { SandboxOperationCapabilities } from './sandbox-runtime.js';

export interface BuildImageInput {
  /** Installs the latest agent releases even when the config turns updates off. */
  pullAgents?: boolean;
  /** A config file other than the repository's own, relative to its root. */
  configPath?: string;
  preset?: PresetSelection;
  logFormat: LogFormat;
}

/** The image the repository's runs use, ready. */
export interface SandboxImageReport {
  image: string;
}

export type BuildImageFailure =
  RepositoryPreparationFailure | ConfigInvalid | SandboxPreparationInvalid | ImageBuildFailed;

export type BuildImageCapabilities = SandboxOperationCapabilities & PresetChooser;

/**
 * Builds the repository's sandbox image when its Dockerfile or agents changed. The repository
 * is prepared and the preset chosen first, so a refusal there builds nothing.
 */
export function buildSandboxImage(
  capabilities: BuildImageCapabilities,
  { pullAgents, configPath, preset, logFormat }: BuildImageInput,
): Promise<Result<SandboxImageReport, BuildImageFailure>> {
  return Result.gen(async function* () {
    const { repository, presetName } = yield* Result.await(
      prepareWithPreset(capabilities, { configPath, preset }),
    );
    const runtime = capabilities.openSandboxRuntime({ ...repository, configPath, logFormat });
    return await withResource(disposableLifetime(runtime), runtime.log, async (opened) => {
      if (presetName !== undefined) {
        opened.log.info({ preset: presetName }, `Using preset ${presetName}`);
      }
      const { image } = opened.sandboxFor(repository);
      const built = await ensureSandboxImage(image, { pullAgents });
      return built.map((name) => ({ image: name }));
    });
  });
}
