import { faker } from '@faker-js/faker';
import { Result } from 'better-result';

import {
  configDestination,
  configFileSource,
} from '../../src/adapters/filesystem/config-source.js';
import { getCurrentBranch } from '../../src/adapters/git/branch.js';
import { ensureRepositoryRoot } from '../../src/adapters/git/repository.js';
import { exactHead } from '../../src/adapters/git/run-history.js';
import { throwawayBranches } from '../../src/adapters/git/throwaway-branches.js';
import { readCredentialsFile } from '../../src/adapters/local-store/credentials-file.js';
import { LocalRunRecords } from '../../src/adapters/local-store/local-run-records.js';
import { lockRun } from '../../src/adapters/local-store/run-lock.js';
import { RepositoryRunStores } from '../../src/adapters/run-store/repository-run-stores.js';
import { RepositoryImageRecipe } from '../../src/adapters/sandbox-image/repository-image-recipe.js';
import { RepositoryStarterFiles } from '../../src/adapters/sandbox-image/starter-files.js';
import { RepositoryAgentCredentials } from '../../src/adapters/sandcastle/agent-credentials.js';
import type {
  OperationContext,
  RepositorySources,
  RunCapabilities,
  RunLog,
  RunRuntime,
  RunSandbox,
  RuntimeRequest,
  SandboxRuntime,
  SandboxSettings,
  StatusCapabilities,
  ThrowawaySandboxes,
} from '../../src/app/api.js';
import { RepositoryInvalid } from '../../src/ports/git-failures.js';
import type { OperationLog } from '../../src/ports/observability.js';
import type { SandboxImages } from '../../src/ports/sandbox-images.js';
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

/**
 * `realRepositorySources` over a plain directory that stands in for the repository rooted at
 * `root`: any other directory is refused as one below it would be.
 */
export function repositorySourcesAt(
  root: string,
  overrides: Partial<RepositorySources> = {},
): RepositorySources {
  return realRepositorySources({
    ensureRepositoryRoot: async (directory) =>
      directory === root
        ? Result.ok()
        : Result.err(new RepositoryInvalid({ message: faker.lorem.sentence() })),
    ...overrides,
  });
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
  {
    sandbox,
    log,
    startingPoint,
  }: { sandbox: RunSandbox; log: RunLog; startingPoint?: RunCapabilities['startingPoint'] },
) {
  let disposed = false;
  const runtime: RunRuntime = {
    run: {
      config,
      log,
      lockRun: (runId) => lockRun(repoRoot, runId),
      runStores: new RepositoryRunStores(repoRoot),
      startingPoint:
        startingPoint ??
        (async () => {
          const baseBranch = await getCurrentBranch(repoRoot);
          if (baseBranch.isErr()) return Result.err(baseBranch.error);
          const startingCommit = await exactHead(repoRoot, 'HEAD');
          return startingCommit.map((commit) => ({
            baseBranch: baseBranch.value,
            startingCommit: commit,
          }));
        }),
      records: new LocalRunRecords(repoRoot),
      sandbox,
    },
    dispose: async () => {
      disposed = true;
    },
  };
  return { runtime, disposed: () => disposed };
}

/**
 * What `jig init` and `jig build` work with over the real repository — its starter files, its
 * credentials file and its branches — with the images, the sandbox and the log given. `settings`
 * reads back what each sandbox was asked for; `disposed` tells whether the operation released it.
 */
export function localSandboxRuntime(
  { repoRoot, configPath }: RuntimeRequest,
  sandbox: {
    images: SandboxImages;
    open: ThrowawaySandboxes['open'];
    log: OperationLog;
    latestVersions?: (npmPackages: string[]) => Promise<Record<string, string | undefined>>;
    branches?: Omit<ThrowawaySandboxes, 'open' | 'log'>;
    saveCredential?: RepositoryAgentCredentials['save'];
  },
) {
  let disposed = false;
  const settings: SandboxSettings[] = [];
  const credentials = new RepositoryAgentCredentials(repoRoot);
  if (sandbox.saveCredential) credentials.save = sandbox.saveCredential;
  const runtime: SandboxRuntime = {
    log: sandbox.log,
    starterFiles: new RepositoryStarterFiles(repoRoot, configDestination(repoRoot, configPath)),
    credentials,
    sandboxFor: (requested) => {
      settings.push(requested);
      return {
        image: {
          config: requested.config,
          images: sandbox.images,
          recipe: new RepositoryImageRecipe(repoRoot, requested.config),
          latestVersions: sandbox.latestVersions ?? (async () => ({})),
          log: sandbox.log,
        },
        throwaway: {
          ...(sandbox.branches ?? throwawayBranches(repoRoot)),
          log: sandbox.log,
          open: sandbox.open,
        },
      };
    },
    dispose: async () => {
      disposed = true;
    },
  };
  return { runtime, settings: () => settings, disposed: () => disposed };
}
