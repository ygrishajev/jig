import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import type { JigOperations } from '../app/api.js';
import { registerPresetsCommand } from './commands/presets.js';
import { registerRunCommand, type RunCommandIo } from './commands/run.js';
import { registerSandboxCommands } from './commands/sandbox.js';
import { registerStatusCommand } from './commands/status.js';
import type { CommandIo } from './app-action.js';

export function buildCli(
  operations: JigOperations,
  runIo: RunCommandIo,
  { failureOutput }: CommandIo = {},
): Command {
  const program = new Command();
  program.name('jig').description('Agentic SDLC pipeline orchestrator').version(packageVersion());
  registerSandboxCommands(program);
  registerRunCommand(program, operations.run, runIo, failureOutput);
  registerStatusCommand(program, operations.status, failureOutput);
  registerPresetsCommand(program, operations.listPresets, failureOutput);
  return program;
}

export function packageVersion(): string {
  const manifest = new URL('../../package.json', import.meta.url);
  return packageManifestSchema.parse(JSON.parse(readFileSync(manifest, 'utf-8'))).version;
}

const packageManifestSchema = z.object({ version: z.string() });
