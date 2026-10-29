#!/usr/bin/env node
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Command } from 'commander';
import { registerRunCommand } from './commands/run.js';
import { registerStatusCommand } from './commands/status.js';

export function buildCli() {
  const program = new Command();
  program.name('sdlc').description('Agentic SDLC pipeline orchestrator').version(packageVersion());
  registerRunCommand(program);
  registerStatusCommand(program);
  return program;
}

function packageVersion() {
  const manifest = new URL('../../package.json', import.meta.url);
  return (JSON.parse(readFileSync(manifest, 'utf-8')) as { version: string }).version;
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
