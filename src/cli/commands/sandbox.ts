import { Result } from 'better-result';
import { Command } from 'commander';
import { z } from 'zod';

import { type InitResult, initSandbox } from '../../app/init-sandbox.js';
import { ensureSandboxImage } from '../../app/sandbox-image.js';
import {
  configInputSchema,
  configOption,
  presetInputSchema,
  presetOption,
} from '../config-option.js';
import { logFormatInputSchema, logFormatOption } from '../log-format-option.js';
import { withApp } from '../with-app.js';
import { withErrorHandling } from '../with-error-handling.js';
import { withInput } from '../with-input.js';

export function registerSandboxCommands(program: Command): void {
  program
    .command('init')
    .description("Set up this repository's sandbox and check its setup and verify commands in it")
    .option('--no-agent', 'only write the starter files and check what is already configured')
    .addOption(configOption())
    .addOption(logFormatOption())
    .action(
      withErrorHandling(
        withInput(initInputSchema, async ({ agent, ...options }) => {
          return withApp(options, async (app) => {
            const result = await initSandbox(app, { useAgent: agent });
            if (result.isErr()) return Result.err(result.error);
            app.cradle.logger.info(initSummary(result.value, app.cradle.configFile.name));
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
    .addOption(configOption())
    .addOption(presetOption())
    .addOption(logFormatOption())
    .action(
      withErrorHandling(
        withInput(buildInputSchema, async ({ pullAgents, ...options }) => {
          return withApp(options, async (app) => {
            const image = await ensureSandboxImage(app.cradle, { pullAgents });
            if (image.isErr()) return Result.err(image.error);
            app.cradle.logger.info(`Sandbox image ready: ${image.value}`);
            return Result.ok();
          });
        }),
      ),
    );
}

const initInputSchema = logFormatInputSchema
  .merge(configInputSchema)
  .extend({ agent: z.boolean() });

export function initSummary(result: InitResult, configName: string): string {
  return INIT_SUMMARY[result.status](result, configName);
}

const INIT_SUMMARY: Record<
  InitResult['status'],
  (result: InitResult, configName: string) => string
> = {
  'needs-agents': (result, configName) =>
    `Wrote .sandcastle/Dockerfile and ${configName}. ${'instruction' in result ? result.instruction : ''} Then run jig init again.`,
  written: (_result, configName) =>
    `Wrote .sandcastle/Dockerfile and ${configName} — add your toolchain and a verifyCommand, then run jig init --no-agent to check them.`,
  verified: (result, configName) =>
    `Sandbox ready: setup and verify pass inside it${'attempts' in result && result.attempts > 1 ? ` (after ${result.attempts} attempts)` : ''}. Review and commit .sandcastle/Dockerfile and ${configName}.`,
  failed: (result) =>
    `Setup or verify did not pass in the sandbox${'attempts' in result && result.attempts > 1 ? ` after ${result.attempts} attempts` : ''} — fix what this shows, then run jig init --no-agent:\n${'failure' in result ? result.failure : ''}`,
};

const buildInputSchema = logFormatInputSchema
  .merge(configInputSchema)
  .merge(presetInputSchema)
  .extend({ pullAgents: z.boolean().optional() });
