import { Argument, Command, Option } from 'commander';
import { execa } from 'execa';

const checks = [
  'build',
  'typecheck',
  'lint',
  'lint:duplication',
  'format:check',
  'test:coverage',
  'test:mutation',
  'secretlint',
];

await new Command()
  .name('npm run validate --')
  .description('Run validations in parallel with grouped output. Defaults to all checks.')
  .addArgument(new Argument('[checks...]', 'Checks to run').choices(checks))
  .addOption(new Option('--skip <checks...>', 'Checks to exclude').choices(checks))
  .action(async (targets: string[], { skip = [] }: { skip?: string[] }) => {
    const selected = (targets.length ? [...new Set(targets)] : checks).filter(
      (check) => !skip.includes(check),
    );
    if (!selected.length) {
      throw new Error('No validation checks selected.');
    }
    console.log(`Running ${selected.length} checks: ${selected.join(', ')}`);
    const results = await Promise.all(selected.map(runCheck));
    process.exitCode = results.some((result) => result.failed) ? 1 : 0;
  })
  .parseAsync()
  .catch((error: Error) => {
    console.error(error.message);
    process.exitCode = 1;
  });

async function runCheck(check: string) {
  const result = await execa('npm', ['run', '--silent', check], {
    all: true,
    reject: false,
  });
  const status = result.failed ? 'FAIL' : 'PASS';
  console.log(`\n=== ${status}: ${check} ===\n${result.all || result.shortMessage || ''}`);
  return result;
}
