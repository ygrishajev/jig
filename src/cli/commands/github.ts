import type { Result } from 'better-result';
import type { Command } from 'commander';
import { z } from 'zod';

import {
  implementIssue,
  type IssueCapabilities,
  type IssueOutcome,
} from '../../app/implement-issue.js';
import type { GithubSettingsInvalid } from '../../config/errors.js';
import { type GithubSettings, githubSettingsFrom } from '../../config/github-settings.js';
import {
  type GithubOriginDiscovery,
  type GithubPort,
  GithubSetupInvalid,
} from '../../ports/github.js';
import { appAction, type CommandIo } from '../app-action.js';
import {
  configInputSchema,
  configOption,
  presetInputSchema,
  presetOption,
} from '../config-option.js';
import { logFormatInputSchema, logFormatOption } from '../log-format-option.js';
import type { Invocation } from '../with-app.js';

/**
 * What the GitHub command is wired with. Each is called only once a command runs, so help and an
 * imported builder need neither a token nor a repository.
 */
export interface GithubCommandDependencies extends Pick<IssueCapabilities, 'publicationAt'> {
  githubFor(token: string): GithubPort;
  githubOriginName: GithubOriginDiscovery;
}

export function registerGithubCommands(
  program: Command,
  { githubFor, githubOriginName, publicationAt }: GithubCommandDependencies,
  io?: CommandIo,
): void {
  const prepare = (
    _input: unknown,
    { cwd, environment }: Invocation,
  ): Promise<Result<GithubSettings, GithubSetupInvalid>> =>
    githubSettingsAt(environment, () => githubOriginName(cwd));
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
        async ({ issue }, app, { token, repository }) => {
          const github = githubFor(token);
          const result = await implementIssue(app, { github, publicationAt }, repository, issue);
          return result.map((outcome) => {
            console.log(describeIssueOutcome(outcome));
          });
        },
        io,
        prepare,
      ),
    );
}

/**
 * The command's GitHub settings, refused before the app opens. A settings refusal becomes the
 * GitHub port's `GithubSetupInvalid`, so the command fails with one setup identity whichever
 * check refused it.
 */
async function githubSettingsAt(
  environment: NodeJS.ProcessEnv,
  originName: () => ReturnType<GithubOriginDiscovery>,
): Promise<Result<GithubSettings, GithubSetupInvalid>> {
  const settings = await githubSettingsFrom(environment, originName);
  return settings.mapError((failure) =>
    failure._tag === 'GithubSettingsInvalid' ? asSetupInvalid(failure) : failure,
  );
}

function asSetupInvalid({ message }: GithubSettingsInvalid): GithubSetupInvalid {
  return new GithubSetupInvalid({ message });
}

const githubInputSchema = logFormatInputSchema
  .merge(configInputSchema)
  .merge(presetInputSchema)
  .extend({ issue: z.coerce.number().int().positive() });

export function describeIssueOutcome(outcome: IssueOutcome): string {
  if (outcome.kind === 'commented') return `${outcome.outcome}: ${outcome.url}`;
  if (outcome.kind === 'refused')
    return `Refused, changes workflows (${outcome.paths.join(', ')}): ${outcome.url}`;
  if (outcome.kind === 'draftPullRequest')
    return `${outcome.reused ? 'Reused draft PR' : 'Draft PR'} (stuck): ${outcome.url}, findings: ${outcome.findingsUrl}`;
  return `${outcome.reused ? 'Reused PR' : 'PR'}: ${outcome.url}`;
}
