import { Result } from 'better-result';
import type { Command } from 'commander';
import { z } from 'zod';

import { appAction, type CommandIo } from '../../cli/app-action.js';
import {
  configInputSchema,
  configOption,
  presetInputSchema,
  presetOption,
} from '../../cli/config-option.js';
import { logFormatInputSchema, logFormatOption } from '../../cli/log-format-option.js';
import type { Invocation } from '../../cli/with-app.js';
import { GithubSetupInvalid } from './errors.js';
import type { GithubPort, RepositoryIdentity } from './github-port.js';
import { implementIssue } from './implement-issue.js';
import { OctokitGithub } from './octokit-github.js';
import { repositoryIdentity } from './repository-identity.js';

export function registerGithubCommands(
  program: Command,
  io?: CommandIo,
  githubFor: (token: string) => GithubPort = OctokitGithub.authenticated,
): void {
  program
    .command('github')
    .description('Implement GitHub issues as pull requests')
    .command('implement')
    .description('Implement an issue and open a pull request')
    .option('--issue <number>', 'issue number')
    .addOption(configOption())
    .addOption(presetOption())
    .addOption(logFormatOption())
    .action(
      appAction(
        githubInputSchema,
        async ({ issue }, app, { token, repository }) =>
          implementIssue(app, githubFor(token), repository, issue),
        io,
        prepare,
      ),
    );
}

const githubInputSchema = logFormatInputSchema
  .merge(configInputSchema)
  .merge(presetInputSchema)
  .extend({ issue: z.coerce.number().int().positive() });

function prepare(
  _input: z.output<typeof githubInputSchema>,
  { cwd, environment }: Invocation,
): Promise<Result<{ token: string; repository: RepositoryIdentity }, GithubSetupInvalid>> {
  return Result.gen(async function* () {
    const token = environment.GITHUB_TOKEN || environment.GH_TOKEN;
    if (!token)
      return Result.err(
        new GithubSetupInvalid({
          message: 'Set GITHUB_TOKEN or GH_TOKEN to implement a GitHub issue.',
        }),
      );
    const repository = yield* Result.await(repositoryIdentity(cwd, environment));
    return Result.ok({ token, repository });
  });
}
