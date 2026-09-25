#!/usr/bin/env node
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

if (import.meta.url === `file://${process.argv[1]}`) {
  buildCli().parse(process.argv);
}
