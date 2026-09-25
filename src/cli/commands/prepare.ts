import { Command } from 'commander';
import { loadConfig } from '../../config/load-config.js';
import { prepareRun } from '../../orchestrator/prepare.js';
import { MarkdownFileInputSource } from '../../strategies/input-source/markdown-file.js';
import { selectProvider } from '../run-context.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerPrepareCommand(program: Command): void {
  program
    .command('prepare')
    .requiredOption('--input <file>', 'path to a markdown request file')
    .action(
      withErrorHandling(async (opts: { input: string }) => {
        const config = loadConfig(process.cwd());
        const meta = await prepareRun({
          repoRoot: process.cwd(),
          inputSource: new MarkdownFileInputSource(opts.input),
          provider: selectProvider(config),
        });
        console.log(`Run ${meta.runId} prepared from ${opts.input}`);
      }),
    );
}
