import { Result } from 'better-result';
import { Command } from 'commander';
import { z } from 'zod';

import { type InitResult, initSandbox } from '../../app/init-sandbox.js';
import { ensureSandboxImage } from '../../app/sandbox-image.js';
import { logFormatInputSchema, logFormatOption } from '../log-format-option.js';
import { withApp } from '../with-app.js';
import { withErrorHandling } from '../with-error-handling.js';
import { withInput } from '../with-input.js';

export function registerSandboxCommands(program: Command): void {
  program
    .command('init')
    .description("Set up this repository's sandbox and check its setup and verify commands in it")
    .option('--no-agent', 'only write the starter files and check what is already configured')
    .addOption(logFormatOption())
    .action(
      withErrorHandling(
        withInput(initInputSchema, async ({ agent, logFormat }) => {
          return withApp(logFormat, async (app) => {
            const result = await initSandbox(app, { useAgent: agent });
            if (result.isErr()) return Result.err(result.error);
            app.cradle.logger.info(initSummary(result.value));
            if (result.value.status === 'failed') process.exitCode = 1;
            return Result.ok();
          });
        }),
      ),
    );

  program
    .command('build')
    .description('Build the sandbox image if the Dockerfile or the agents changed')
    .option('--pull-agents', 'install the latest agent releases even if updates are off')
    .addOption(logFormatOption())
    .action(
      withErrorHandling(
        withInput(buildInputSchema, async ({ pullAgents, logFormat }) => {
          return withApp(logFormat, async (app) => {
            const image = await ensureSandboxImage(app.cradle, { pullAgents });
            if (image.isErr()) return Result.err(image.error);
            app.cradle.logger.info(`Sandbox image ready: ${image.value}`);
            return Result.ok();
          });
        }),
      ),
    );
}

const initInputSchema = logFormatInputSchema.extend({ agent: z.boolean() });

export function initSummary(result: InitResult): string {
  return INIT_SUMMARY[result.status](result);
}

const INIT_SUMMARY: Record<InitResult['status'], (result: InitResult) => string> = {
  written: () =>
    'Wrote .sandcastle/Dockerfile and jig.config.json — add your toolchain and a verifyCommand, then run jig init --no-agent to check them.',
  verified: (result) =>
    `Sandbox ready: setup and verify pass inside it${'attempts' in result && result.attempts > 1 ? ` (after ${result.attempts} attempts)` : ''}. Review and commit .sandcastle/Dockerfile and jig.config.json.`,
  failed: (result) =>
    `Setup or verify did not pass in the sandbox${'attempts' in result && result.attempts > 1 ? ` after ${result.attempts} attempts` : ''} — fix what this shows, then run jig init --no-agent:\n${'failure' in result ? result.failure : ''}`,
};

const buildInputSchema = logFormatInputSchema.extend({ pullAgents: z.boolean().optional() });
