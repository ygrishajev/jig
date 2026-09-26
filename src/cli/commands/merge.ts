import { Command } from 'commander';
import { advanceRun } from '../../orchestrator/advance.js';
import { AutoMergeStrategy } from '../../strategies/merge/auto.js';
import { loadCliRunContext } from '../run-context.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerMergeCommand(program: Command): void {
  program
    .command('merge')
    .requiredOption('--run <id>', 'run id')
    .action(
      withErrorHandling(async (opts: { run: string }) => {
        const context = await loadCliRunContext(process.cwd(), opts.run);
        // Deliberately a fresh AutoMergeStrategy(), not context.mergeStrategy:
        // an explicit `sdlc merge` invocation IS the human's decision to
        // merge now, regardless of the configured mergeMode. Under manual
        // mode, context.mergeStrategy would be a no-op ManualMergeStrategy,
        // which would make this command do nothing.
        const result = await advanceRun({ ...context, mergeStrategy: new AutoMergeStrategy() });
        console.log(
          result.advanced
            ? `Merged. Current slice is now: ${result.currentSliceId ?? '(run complete)'}`
            : `Nothing to merge yet for the current slice.`,
        );
      }),
    );
}
