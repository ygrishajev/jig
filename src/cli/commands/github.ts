import type { Command } from 'commander';
import { z } from 'zod';

import type { IssueOutcome, JigOperations } from '../../app/api.js';
import {
  configInputSchema,
  configOption,
  presetInputSchema,
  presetOption,
} from '../config-option.js';
import { logFormatInputSchema, logFormatOption } from '../log-format-option.js';
import { type FailureOutput, withErrorHandling } from '../with-error-handling.js';
import { withInput } from '../with-input.js';

export function registerGithubCommands(
  program: Command,
  implementIssue: JigOperations['implementIssue'],
  failureOutput?: FailureOutput,
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
      withErrorHandling(
        withInput(githubInputSchema, async ({ issue, config, preset, logFormat }) => {
          const outcome = await implementIssue({
            issueNumber: issue,
            configPath: config,
            preset,
            logFormat,
          });
          return outcome.map((published) => {
            console.log(describeIssueOutcome(published));
          });
        }),
        failureOutput,
      ),
    );
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
