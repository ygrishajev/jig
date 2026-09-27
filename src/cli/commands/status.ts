import { Command } from 'commander';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { loadRunState, readRunMeta, readSlices } from '../../state/store.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerStatusCommand(program: Command): void {
  program
    .command('status')
    .requiredOption('--run <id>', 'run id')
    .action(
      withErrorHandling(async (opts: { run: string }) => {
        const paths = await loadRunState(process.cwd(), opts.run);
        const meta = await readRunMeta(paths);
        const slices = await readSlices(paths);
        console.log(
          `Run ${meta.runId} (base: ${meta.baseBranch}, current: ${meta.currentSliceId ?? '—'})`,
        );
        for (const [label, filename] of [
          ['Design', 'design.md'],
          ['Plan', 'plan.md'],
        ] as const) {
          const docPath = path.join(paths.stateDir, filename);
          if (existsSync(docPath)) console.log(`${label}: ${docPath}`);
        }
        for (const slice of slices) {
          console.log(`  [${slice.status}] ${slice.id} — ${slice.title}`);
        }
      }),
    );
}
