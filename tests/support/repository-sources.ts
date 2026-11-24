import { faker } from '@faker-js/faker';
import { Result } from 'better-result';

import {
  configDestination,
  configFileSource,
} from '../../src/adapters/filesystem/config-source.js';
import { getCurrentBranch } from '../../src/adapters/git/branch.js';
import { ensureRepositoryRoot } from '../../src/adapters/git/repository.js';
import { exactHead } from '../../src/adapters/git/run-history.js';
import { readCredentialsFile } from '../../src/adapters/local-store/credentials-file.js';
import { LocalRunRecords } from '../../src/adapters/local-store/local-run-records.js';
import { lockRun } from '../../src/adapters/local-store/run-lock.js';
import { RepositoryRunStores } from '../../src/adapters/run-store/repository-run-stores.js';
import type {
  OperationContext,
  RepositorySources,
  RunLog,
  RunRuntime,
  RunSandbox,
  RuntimeRequest,
  StatusCapabilities,
} from '../../src/app/api.js';
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
    runStoresAt: (repoRoot) => new RepositoryRunStores(repoRoot),
    ...overrides,
  };
}

/**
 * A run's runtime over the real repository, its lock, stores and records, with the sandbox and
 * log given; `disposed` tells whether the run released it.
 */
export function localRunRuntime(
  { repoRoot, config }: RuntimeRequest,
  { sandbox, log }: { sandbox: RunSandbox; log: RunLog },
) {
  let disposed = false;
  const runtime: RunRuntime = {
    run: {
      config,
      log,
      lockRun: (runId) => lockRun(repoRoot, runId),
      runStores: new RepositoryRunStores(repoRoot),
      startingPoint: async () => {
        const baseBranch = await getCurrentBranch(repoRoot);
        if (baseBranch.isErr()) return Result.err(baseBranch.error);
        const startingCommit = await exactHead(repoRoot, 'HEAD');
        return startingCommit.map((commit) => ({
          baseBranch: baseBranch.value,
          startingCommit: commit,
        }));
      },
      records: new LocalRunRecords(repoRoot),
      sandbox,
    },
    dispose: async () => {
      disposed = true;
    },
  };
  return { runtime, disposed: () => disposed };
}
