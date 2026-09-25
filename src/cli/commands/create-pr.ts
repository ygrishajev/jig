import { Command } from 'commander';
import { LocalPrCreateStrategy } from '../../strategies/pr/local.js';
import { readRunMeta, readSlices } from '../../state/store.js';
import { loadCliRunContext } from '../run-context.js';

export function registerCreatePrCommand(program: Command): void {
  program
    .command('create-pr')
    .requiredOption('--run <id>', 'run id')
    .action(async (opts: { run: string }) => {
      const context = await loadCliRunContext(process.cwd(), opts.run);
      const meta = await readRunMeta(context.paths);
      const slices = await readSlices(context.paths);
      const slice = slices.find((candidate) => candidate.id === meta.currentSliceId);
      if (!slice) {
        console.log('No current slice to create a PR description for.');
        return;
      }
      await new LocalPrCreateStrategy().create(context.paths, slice);
      console.log(`Wrote PR description for "${slice.id}" to the workspace.`);
    });
}
