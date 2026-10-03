import { Command } from 'commander';
import path from 'node:path';
import { LocalPrCreateStrategy } from '../../strategies/pr/local.js';
import { loadCliRunContext, selectProvider } from '../run-context.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerCreatePrCommand(program: Command): void {
  program
    .command('create-pr')
    .requiredOption('--run <id>', 'run id')
    .action(
      withErrorHandling(async (opts: { run: string }) => {
        const context = await loadCliRunContext(process.cwd(), opts.run);
        await new LocalPrCreateStrategy({
          provider: selectProvider(context.config, 'describer'),
          verifyCommand: context.config.verifyCommand,
        }).create(context.paths);
        console.log(
          `Wrote PR description to ${path.join(context.paths.stateDir, 'PR_DESCRIPTION.md')}`,
        );
      }),
    );
}
