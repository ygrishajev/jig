import { Result } from 'better-result';

import type { ConfigInvalid } from '../config/errors.js';
import { discoverPresets, type Preset } from '../config/presets.js';
import {
  type OperationContext,
  prepareRepository,
  type RepositoryPreparationFailure,
  type RepositorySources,
} from './repository-preparation.js';

export type PresetListingFailure = RepositoryPreparationFailure | ConfigInvalid;

export interface PresetListingCapabilities extends RepositorySources {
  context(): OperationContext;
}

/**
 * Every preset `--preset` can name in this repository, the one that wins for each name. The
 * repository is prepared as for any other command, so a config or credentials file it cannot
 * read is refused here too.
 */
export function listPresets(
  capabilities: PresetListingCapabilities,
): Promise<Result<Preset[], PresetListingFailure>> {
  return Result.gen(async function* () {
    const { presetSource } = yield* Result.await(
      prepareRepository(capabilities.context(), capabilities),
    );
    return discoverPresets(presetSource);
  });
}
