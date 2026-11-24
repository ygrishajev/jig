#!/usr/bin/env node
import type { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { configDestination, configFileSource } from '../adapters/filesystem/config-source.js';
import { presetDirectoriesSource } from '../adapters/filesystem/preset-source.js';
import { githubOriginName } from '../adapters/git/github-origin.js';
import { GitOrchestrationStore } from '../adapters/git/orchestration-ref.js';
import { ensureRepositoryRoot } from '../adapters/git/repository.js';
import { GitRunBranches } from '../adapters/git/run-branches.js';
import { OctokitGithub } from '../adapters/github/octokit-github.js';
import { readCredentialsFile } from '../adapters/local-store/credentials-file.js';
import { LocalRunRecords } from '../adapters/local-store/local-run-records.js';
import { createConsoleLogger } from '../adapters/logging/create-logger.js';
import { RepositoryRunStores } from '../adapters/run-store/repository-run-stores.js';
import { askForAgents } from '../adapters/terminal/ask-for-agents.js';
import { askForCredential } from '../adapters/terminal/ask-for-credential.js';
import { askForPreset } from '../adapters/terminal/ask-for-preset.js';
import { processRequestInputs } from '../adapters/terminal/standard-input.js';
import {
  buildSandboxImage,
  implementGithubIssue,
  initRepository,
  type JigOperations,
  listPresets,
  type OperationContext,
  readRunStatus,
  type RepositorySources,
  startOrResumeRun,
} from '../app/api.js';
import { openRunRuntime, openSandboxRuntime } from '../app/container.js';
import { registerGithubCommands } from '../cli/commands/github.js';
import type { RunCommandIo } from '../cli/commands/run.js';
import { exitWhenDone } from '../cli/exit-when-done.js';
import { buildCli } from '../cli/main.js';
import type { FailureOutput } from '../cli/with-error-handling.js';

export function buildJigCli(failureOutput?: FailureOutput): Command {
  const program = buildCli(operations, runIo, failureOutput);
  registerGithubCommands(program, operations.implementIssue, failureOutput);
  return program;
}

const repositorySources: RepositorySources = {
  ensureRepositoryRoot,
  readSavedCredentials: readCredentialsFile,
  configSourceFor: (repoRoot, configPath) =>
    configFileSource(configDestination(repoRoot, configPath)),
  presetSourceFor: (places) => presetDirectoriesSource(places),
};

/** Read when an operation runs, not when the CLI is built. */
const processContext = (): OperationContext => ({
  cwd: process.cwd(),
  environment: process.env,
  fallbackHomeDirectory: homedir(),
});

const operations: JigOperations = {
  run: (input) =>
    startOrResumeRun(
      { ...repositorySources, context: processContext, askForPreset, openRuntime: openRunRuntime },
      input,
    ),
  status: (input) =>
    readRunStatus(
      {
        ...repositorySources,
        context: processContext,
        runRecordsAt: (repoRoot) => new LocalRunRecords(repoRoot),
        runStoresAt: (repoRoot) => new RepositoryRunStores(repoRoot),
      },
      input,
    ),
  listPresets: () => listPresets({ ...repositorySources, context: processContext }),
  init: (input) =>
    initRepository(
      {
        ...repositorySources,
        context: processContext,
        openSandboxRuntime,
        askForAgents,
        askForCredential,
      },
      input,
    ),
  buildImage: (input) =>
    buildSandboxImage(
      { ...repositorySources, context: processContext, openSandboxRuntime, askForPreset },
      input,
    ),
  implementIssue: (input) =>
    implementGithubIssue(
      {
        ...repositorySources,
        context: processContext,
        askForPreset,
        openRuntime: openRunRuntime,
        githubFor: (token) => OctokitGithub.authenticated(token),
        githubOriginName,
        publicationAt: (repoRoot) => ({
          receipts: new GitOrchestrationStore(repoRoot),
          runBranches: new GitRunBranches(repoRoot),
        }),
      },
      input,
    ),
};

const runIo: RunCommandIo = {
  requestInputs: processRequestInputs(),
  outcomeLog: (format) => createConsoleLogger(format),
};

/**
 * A globally installed CLI is invoked through a symlink, so the invoked path is resolved
 * before comparing it with this module's own path.
 */
const isMainModule =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  await buildJigCli().parseAsync(process.argv);
  await exitWhenDone();
}
