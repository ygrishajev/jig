import { Command } from 'commander';
import { runReconcilerPass } from '../../orchestrator/reconcile.js';
import { loadCliRunContext, selectProvider } from '../run-context.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerStepCommands(program: Command): void {
  for (const name of ['implement', 'review'] as const) {
    program
      .command(name)
      .requiredOption('--run <id>', 'run id')
      .action(
        withErrorHandling(async (opts: { run: string }) => {
          const context = await loadCliRunContext(process.cwd(), opts.run);
          const result = await runReconcilerPass({ ...context, provider: selectProvider() });
          if (result.blocked) {
            console.log(`Blocked: ${result.reason}`);
            return;
          }
          console.log(result.complete ? 'Run complete.' : 'Step complete.');
        }),
      );
  }
}
