#!/usr/bin/env node
import type { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { githubOriginName } from '../adapters/git/github-origin.js';
import { GitOrchestrationStore } from '../adapters/git/orchestration-ref.js';
import { GitRunBranches } from '../adapters/git/run-branches.js';
import { OctokitGithub } from '../adapters/github/octokit-github.js';
import type { CommandIo } from '../cli/app-action.js';
import { type GithubCommandDependencies, registerGithubCommands } from '../cli/commands/github.js';
import { exitWhenDone } from '../cli/exit-when-done.js';
import { buildCli } from '../cli/main.js';

export function buildJigCli(io?: CommandIo): Command {
  const program = buildCli();
  registerGithubCommands(program, githubDependencies, io);
  return program;
}

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
