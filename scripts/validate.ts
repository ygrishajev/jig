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
  'secretlint',
] as const;
/** Too slow to hold up a change; each runs only when named. */
const optInChecks = ['test:integration', 'test:mutation'] as const;
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
    'Run the fast validations in parallel with grouped output. Integration and mutation testing are opt-in.',
  )
  .addArgument(checksArgument)
  .addOption(skipOption)
  .action(
    withErrorHandling(
      withInput(validationInputSchema, async (selected) => {
        console.log(`Running ${selected.length} checks: ${selected.join(', ')}`);
        const omitted = optInChecks.filter((check) => !selected.includes(check));
        if (omitted.length > 0) console.log(`Omitted (opt-in): ${omitted.join(', ')}`);
        const results = await Promise.all(selected.map(runCheck));
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
