import { Command } from 'commander';
import { readFileSync } from 'node:fs';
import { z } from 'zod';

import type { ExceptionDetails } from '../ports/exception-details.js';
import { registerPresetsCommand } from './commands/presets.js';
import { registerRunCommand } from './commands/run.js';
import { registerSandboxCommands } from './commands/sandbox.js';
import { registerStatusCommand } from './commands/status.js';

export function buildCli(exceptionDetails: ExceptionDetails): Command {
  const program = new Command();
  program.name('jig').description('Agentic SDLC pipeline orchestrator').version(packageVersion());
  registerSandboxCommands(program, { exceptionDetails });
  registerRunCommand(program, { exceptionDetails });
  registerStatusCommand(program, exceptionDetails);
  registerPresetsCommand(program, exceptionDetails);
  return program;
}

export function packageVersion(): string {
  const manifest = new URL('../../package.json', import.meta.url);
  return packageManifestSchema.parse(JSON.parse(readFileSync(manifest, 'utf-8'))).version;
}

const packageManifestSchema = z.object({ version: z.string() });
