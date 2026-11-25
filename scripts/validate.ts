import { Result } from 'better-result';
import { Argument, Command, Option } from 'commander';
import { execa, type Result as ExecResult } from 'execa';
import { z } from 'zod';

import { withErrorHandling } from '../src/cli/with-error-handling.js';
import { withInput } from '../src/cli/with-input.js';

const defaultChecks = [
  'build',
  'typecheck',
  'lint',
  'lint:duplication',
  'lint:dependencies',
  'format:check',
  'test:coverage',
  'test:integration',
  'secretlint',
] as const;
/** Too slow to hold up a change; runs only when named. */
const optInChecks = ['test:mutation'] as const;
/** Starts enough processes of its own that sharing the machine makes its specs time out. */
const RUNS_ALONE = 'test:integration';
const checkSchema = z.enum([...defaultChecks, ...optInChecks]);
const validationInputSchema = z
  .object({ checks: z.array(checkSchema), skip: z.array(checkSchema).default([]) })
  .transform(({ checks, skip }, context) => {
    const selected = [...new Set(checks.length ? checks : defaultChecks)].filter(
      (check) => !skip.includes(check),
    );
    if (selected.length) return selected;
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'No validation checks selected.' });
    return z.NEVER;
  });
const checksArgument = new Argument('[checks...]', 'Checks to run');
checksArgument.argChoices = checkSchema.options;
const skipOption = new Option('--skip <checks...>', 'Checks to exclude');
skipOption.argChoices = checkSchema.options;

await new Command()
  .name('npm run validate --')
  .description(
    'Run validations in parallel, integration specs after the rest, with grouped output. Mutation testing is opt-in.',
  )
  .addArgument(checksArgument)
  .addOption(skipOption)
  .action(
    withErrorHandling(
      withInput(validationInputSchema, async (selected) => {
        console.log(`Running ${selected.length} checks: ${selected.join(', ')}`);
        const omitted = optInChecks.filter((check) => !selected.includes(check));
        if (omitted.length > 0) console.log(`Omitted (opt-in): ${omitted.join(', ')}`);
        const together = selected.filter((check) => check !== RUNS_ALONE);
        const results = await Promise.all(together.map(runCheck));
        if (selected.includes(RUNS_ALONE)) results.push(await runCheck(RUNS_ALONE));
        process.exitCode = results.some((result) => result.failed) ? 1 : 0;
        return Result.ok();
      }),
    ),
  )
  .parseAsync()
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

async function runCheck(check: string): Promise<ExecResult<{ all: true; reject: false }>> {
  const result = await execa('npm', ['run', '--silent', check], {
    all: true,
    reject: false,
  });
  const status = result.failed ? 'FAIL' : 'PASS';
  console.log(`\n=== ${status}: ${check} ===\n${result.all || result.shortMessage || ''}`);
  return result;
}
