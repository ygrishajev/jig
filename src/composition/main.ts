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
import {
  type JigOperations,
  listPresets,
  type OperationContext,
  readRunStatus,
  type RepositorySources,
} from '../app/api.js';
import type { CommandIo } from '../cli/app-action.js';
import { type GithubCommandDependencies, registerGithubCommands } from '../cli/commands/github.js';
import { exitWhenDone } from '../cli/exit-when-done.js';
import { buildCli } from '../cli/main.js';

export function buildJigCli(io?: CommandIo): Command {
  const program = buildCli(operations, io);
  registerGithubCommands(program, githubDependencies, io);
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
  status: (input) =>
    readRunStatus(
      {
        ...repositorySources,
        context: processContext,
        runRecordsAt: (repoRoot) => new LocalRunRecords(repoRoot),
      },
      input,
    ),
  listPresets: () => listPresets({ ...repositorySources, context: processContext }),
};

/** Built on demand: an imported builder or `--help` touches neither GitHub nor the clone. */
const githubDependencies: GithubCommandDependencies = {
  githubFor: (token) => OctokitGithub.authenticated(token),
  githubOriginName,
  publicationAt: (repoRoot) => ({
    receipts: new GitOrchestrationStore(repoRoot),
    runBranches: new GitRunBranches(repoRoot),
  }),
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
