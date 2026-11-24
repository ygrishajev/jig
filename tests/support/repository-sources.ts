import { faker } from '@faker-js/faker';

import {
  configDestination,
  configFileSource,
} from '../../src/adapters/filesystem/config-source.js';
import { ensureRepositoryRoot } from '../../src/adapters/git/repository.js';
import { readCredentialsFile } from '../../src/adapters/local-store/credentials-file.js';
import { LocalRunRecords } from '../../src/adapters/local-store/local-run-records.js';
import type { OperationContext, RepositorySources, StatusCapabilities } from '../../src/app/api.js';
import { InMemoryPresetSource } from './fakes.js';

/**
 * The repository sources jig runs with, over a real repository, its config file and its
 * credentials file; presets are held in memory. Override any of them for what a spec is about.
 */
export function realRepositorySources(
  overrides: Partial<RepositorySources> = {},
): RepositorySources {
  return {
    ensureRepositoryRoot,
    readSavedCredentials: readCredentialsFile,
    configSourceFor: (repoRoot, configPath) =>
      configFileSource(configDestination(repoRoot, configPath)),
    presetSourceFor: () => new InMemoryPresetSource(),
    ...overrides,
  };
}

/** A context started in `cwd` with nothing but `environment` set. */
export function operationContextIn(
  cwd: string,
  environment: OperationContext['environment'] = {},
): OperationContext {
  return { cwd, environment, fallbackHomeDirectory: faker.system.directoryPath() };
}

/** Status over a real repository and this machine's records of its runs. */
export function realStatusCapabilities(
  cwd: string,
  overrides: Partial<StatusCapabilities> = {},
): StatusCapabilities {
  return {
    ...realRepositorySources(),
    context: () => operationContextIn(cwd),
    runRecordsAt: (repoRoot) => new LocalRunRecords(repoRoot),
    ...overrides,
  };
}
