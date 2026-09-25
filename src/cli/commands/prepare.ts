import { Command } from 'commander';
import { prepareRun } from '../../orchestrator/prepare.js';
import { MarkdownFileInputSource } from '../../strategies/input-source/markdown-file.js';
import { selectProvider } from '../run-context.js';

export function registerPrepareCommand(program: Command): void {
  program
    .command('prepare')
    .requiredOption('--input <file>', 'path to a markdown request file')
    .action(async (opts: { input: string }) => {
      const meta = await prepareRun({
        repoRoot: process.cwd(),
        inputSource: new MarkdownFileInputSource(opts.input),
        provider: selectProvider(),
      });
      console.log(`Run ${meta.runId} prepared from ${opts.input}`);
    });
}
