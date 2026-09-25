import { Command } from 'commander';
import { advanceRun } from '../../orchestrator/advance.js';
import { AutoMergeStrategy } from '../../strategies/merge/auto.js';
import { loadCliRunContext } from '../run-context.js';

export function registerMergeCommand(program: Command): void {
  program
    .command('merge')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const context = await loadCliRunContext(process.cwd(), opts.run);
      const result = await advanceRun({ ...context, mergeStrategy: new AutoMergeStrategy() });
      console.log(
        result.advanced
          ? `Merged. Current slice is now: ${result.currentSliceId ?? '(run complete)'}`
          : `Nothing to merge yet for the current slice.`,
      );
    });
}
