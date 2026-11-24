#!/usr/bin/env node
import type { Command } from 'commander';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import type { CommandIo } from '../cli/app-action.js';
import { exitWhenDone } from '../cli/exit-when-done.js';
import { buildCli } from '../cli/main.js';
import { registerGithubCommands } from '../integrations/github/command.js';
import type { GithubPort } from '../integrations/github/github-port.js';

export function buildJigCli(io?: CommandIo, githubFor?: (token: string) => GithubPort): Command {
  const program = buildCli();
  registerGithubCommands(program, io, githubFor);
  return program;
}

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
