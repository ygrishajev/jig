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
    const parsed = githubEnvironmentSchema.safeParse(environment);
    if (!parsed.success)
      return Result.err(
        new GithubSetupInvalid({
          message: parsed.error.issues.map(({ message }) => message).join('; '),
        }),
      );
    const { token, ...identity } = parsed.data;
    const repository = yield* Result.await(repositoryIdentity(cwd, identity));
    return Result.ok({ token, repository });
  });
}

const githubEnvironmentSchema = z
  .object({
    GITHUB_TOKEN: z.string().min(1).optional(),
    GH_TOKEN: z.string().min(1).optional(),
    GITHUB_REPOSITORY: z.string().optional(),
  })
  .transform(({ GITHUB_TOKEN, GH_TOKEN, GITHUB_REPOSITORY }, context) => {
    const token = GITHUB_TOKEN ?? GH_TOKEN;
    if (!token) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'Set GITHUB_TOKEN or GH_TOKEN to implement a GitHub issue.',
      });
      return z.NEVER;
    }
    return { token, GITHUB_REPOSITORY };
  });
