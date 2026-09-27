import { Command } from 'commander';
import { finalizeRun } from '../../orchestrator/finalize-run.js';
import { AutoMergeStrategy } from '../../strategies/merge/auto.js';
import { readRunMeta } from '../../state/store.js';
import { loadCliRunContext } from '../run-context.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerMergeCommand(program: Command): void {
  program
    .command('merge')
    .requiredOption('--run <id>', 'run id')
    .action(
      withErrorHandling(async (opts: { run: string }) => {
        const context = await loadCliRunContext(process.cwd(), opts.run);
        const meta = await readRunMeta(context.paths);
        if (meta.currentSliceId !== null) {
          console.log('Nothing to merge yet — the run still has a slice pending or in review.');
          return;
        }
        // Deliberately a fresh AutoMergeStrategy(), not context.mergeStrategy:
        // an explicit `sdlc merge` invocation IS the human's decision to
        // merge now, regardless of the configured mergeMode. Under manual
        // mode, context.mergeStrategy would be a no-op ManualMergeStrategy,
        // which would make this command do nothing.
        const result = await finalizeRun({ ...context, mergeStrategy: new AutoMergeStrategy() });
        console.log(result.complete ? `Merged. Run "${opts.run}" complete.` : 'Nothing to merge yet.');
      }),
    );
}
