import { Command } from 'commander';

import type { LogFormat } from '../../adapters/logging/create-logger.js';
import { type InitResult, initSandbox } from '../../app/init-sandbox.js';
import { ensureSandboxImage } from '../../app/sandbox-image.js';
import { withApp } from '../with-app.js';
import { withErrorHandling } from '../with-error-handling.js';
import { logFormatOption } from './run.js';

const INIT_SUMMARY: Record<InitResult['status'], (result: InitResult) => string> = {
  written: () =>
    'Wrote .sandcastle/Dockerfile and sdlc.config.json — add your toolchain and a verifyCommand, then run sdlc init --no-agent to check them.',
  verified: (result) =>
    `Sandbox ready: setup and verify pass inside it${'attempts' in result && result.attempts > 1 ? ` (after ${result.attempts} attempts)` : ''}. Review and commit .sandcastle/Dockerfile and sdlc.config.json.`,
  failed: (result) =>
    `Setup or verify did not pass in the sandbox${'attempts' in result && result.attempts > 1 ? ` after ${result.attempts} attempts` : ''} — fix what this shows, then run sdlc init --no-agent:\n${'failure' in result ? result.failure : ''}`,
};

export function initSummary(result: InitResult) {
  return INIT_SUMMARY[result.status](result);
}

export function registerSandboxCommands(program: Command) {
  program
    .command('init')
    .description("Set up this repository's sandbox and check its setup and verify commands in it")
    .option('--no-agent', 'only write the starter files and check what is already configured')
    .addOption(logFormatOption())
    .action(
      withErrorHandling(async (options: { agent: boolean; logFormat: LogFormat }) => {
        await withApp(options.logFormat, async (app) => {
          const result = await initSandbox(app, { useAgent: options.agent });
          app.cradle.logger.info(initSummary(result));
          if (result.status === 'failed') process.exitCode = 1;
        });
      }),
    );

  program
    .command('build')
    .description('Build the sandbox image if the Dockerfile or the agents changed')
    .option('--pull-agents', 'install the latest agent releases even if updates are off')
    .addOption(logFormatOption())
    .action(
      withErrorHandling(async (options: { pullAgents?: boolean; logFormat: LogFormat }) => {
        await withApp(options.logFormat, async (app) => {
          const image = await ensureSandboxImage(app.cradle, { pullAgents: options.pullAgents });
          app.cradle.logger.info(`Sandbox image ready: ${image}`);
        });
      }),
    );
}
