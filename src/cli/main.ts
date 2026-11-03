#!/usr/bin/env node
import { Command } from 'commander';
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

import { registerRunCommand } from './commands/run.js';
import { registerSandboxCommands } from './commands/sandbox.js';
import { registerStatusCommand } from './commands/status.js';

const packageManifestSchema = z.object({ version: z.string() });

export function buildCli() {
  const program = new Command();
  program.name('jig').description('Agentic SDLC pipeline orchestrator').version(packageVersion());
  registerSandboxCommands(program);
  registerRunCommand(program);
  registerStatusCommand(program);
  return program;
}

function packageVersion() {
  const manifest = new URL('../../package.json', import.meta.url);
  return packageManifestSchema.parse(JSON.parse(readFileSync(manifest, 'utf-8'))).version;
}

/**
 * A globally installed CLI is invoked through a symlink, so the invoked path is resolved
 * before comparing it with this module's own path.
 */
const isMainModule =
  process.argv[1] !== undefined && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url);

if (isMainModule) {
  await buildCli().parseAsync(process.argv);
}
