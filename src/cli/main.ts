#!/usr/bin/env node
import { Command } from 'commander';

export function buildCli(): Command {
  const program = new Command();
  program.name('sdlc').description('Agentic SDLC pipeline orchestrator').version('0.1.0');
  return program;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  buildCli().parse(process.argv);
}
