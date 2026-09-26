#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerPrepareCommand } from './commands/prepare.js';
import { registerStepCommands } from './commands/step.js';
import { registerMergeCommand } from './commands/merge.js';
import { registerCreatePrCommand } from './commands/create-pr.js';
import { registerStatusCommand } from './commands/status.js';
import { registerAutopilotCommands } from './commands/autopilot.js';

export function buildCli(): Command {
  const program = new Command();
  program.name('sdlc').description('Agentic SDLC pipeline orchestrator').version('0.1.0');
  registerPrepareCommand(program);
  registerStepCommands(program);
  registerMergeCommand(program);
  registerCreatePrCommand(program);
  registerStatusCommand(program);
  registerAutopilotCommands(program);
  return program;
}

// `import.meta.url` reflects the module's resolved real path, but
// `process.argv[1]` is whatever path was invoked — a symlink when this runs
// as a globally installed CLI (npm/Volta install bins as symlinks into
// node_modules). Comparing raw strings only matches when invoked with no
// symlink in the way (e.g. `node dist/cli/main.js` directly), so it silently
// never fires for a real global install. Resolve the invoked path's realpath
// before comparing.
const isMainModule =
  process.argv[1] !== undefined &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  await buildCli().parseAsync(process.argv);
}
