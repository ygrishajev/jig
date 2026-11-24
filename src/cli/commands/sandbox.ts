import { Command } from 'commander';
import { z } from 'zod';

import type { InitResult, JigOperations } from '../../app/api.js';
import {
  configInputSchema,
  configOption,
  presetInputSchema,
  presetOption,
} from '../config-option.js';
import { logFormatInputSchema, logFormatOption } from '../log-format-option.js';
import {
  type FailureOutput,
  processFailureOutput,
  withErrorHandling,
} from '../with-error-handling.js';
import { withInput } from '../with-input.js';
import type { RunCommandIo } from './run.js';

/** The operations the sandbox commands call. */
export type SandboxOperations = Pick<JigOperations, 'init' | 'buildImage'>;

export function registerSandboxCommands(
  program: Command,
  { init, buildImage }: SandboxOperations,
  { outcomeLog }: Pick<RunCommandIo, 'outcomeLog'>,
  failureOutput: FailureOutput = processFailureOutput,
): void {
  program
    .command('init')
    .description("Set up this repository's sandbox and check its setup and verify commands in it")
    .option('--no-agent', 'only write the starter files and check what is already configured')
    .addOption(configOption())
    .addOption(logFormatOption())
    .action(
      withErrorHandling(
        withInput(initInputSchema, async ({ agent, config, logFormat }) => {
          const initialized = await init({ useAgent: agent, configPath: config, logFormat });
          return initialized.map(({ outcome, configName }) => {
            outcomeLog(logFormat).info(
              { status: outcome.status },
              initSummary(outcome, configName),
            );
            if (outcome.status === 'failed') failureOutput.setExitCode(1);
          });
        }),
        failureOutput,
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
        withInput(buildInputSchema, async ({ pullAgents, config, preset, logFormat }) => {
          const built = await buildImage({ pullAgents, configPath: config, preset, logFormat });
          return built.map(({ image }) => {
            outcomeLog(logFormat).info({ image }, `Sandbox image ready: ${image}`);
          });
        }),
        failureOutput,
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

export const buildInputSchema = logFormatInputSchema
  .merge(configInputSchema)
  .merge(presetInputSchema)
  .extend({ pullAgents: z.boolean().optional() });
