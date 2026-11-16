import { Result } from 'better-result';
import { Command } from 'commander';
import { z } from 'zod';

import { runJig, type RunJigInput, type RunReport } from '../../app/run-jig.js';
import { type RunId, runIdSchema } from '../../domain/run-id.js';
import { runBranchFor, type RunState, runStopReason } from '../../domain/run-state.js';
import { appAction, type CommandIo } from '../app-action.js';
import {
  configInputSchema,
  configOption,
  presetInputSchema,
  presetOption,
} from '../config-option.js';
import { logFormatInputSchema, logFormatOption } from '../log-format-option.js';

export function registerRunCommand(program: Command, io?: CommandIo): void {
  program
    .command('run')
    .description('Start a run from a request file, or resume one with --id')
    .argument('[request]', 'markdown file describing what to build')
    .option('--id <id>', 'run id: resumes that run if it exists, otherwise names the new one')
    .addOption(configOption())
    .addOption(presetOption())
    .addOption(logFormatOption())
    .action(
      appAction(
        runInputSchema,
        async ({ run }, app) => {
          const report = await runJig(app, run);
          if (report.isErr()) return Result.err(report.error);
          app.cradle.logger.info(
            { runId: report.value.state.runId, branch: runBranchFor(report.value.state.runId) },
            nextStep(report.value),
          );
          return Result.ok();
        },
        io,
      ),
    );
}

/**
 * `jig run [request] [--id <id>]`: a request starts a run, named by `--id` when given; an id
 * alone resumes that run.
 */
export const runInputSchema = logFormatInputSchema
  .merge(configInputSchema)
  .merge(presetInputSchema)
  .extend({ request: z.string().optional(), id: runIdSchema.optional() })
  .transform(({ request, id, ...options }, context) => {
    const run = runToDo(request, id);
    if (run) return { run, ...options };
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Pass a request file to start a run, or --id to resume one.',
    });
    return z.NEVER;
  });

function runToDo(request: string | undefined, id: RunId | undefined): RunJigInput | undefined {
  if (request !== undefined) return id ? { start: request, runId: id } : { start: request };
  if (id) return { resume: id };
  return undefined;
}

/** What the operator does next, for where the run stopped. */
export function nextStep(report: RunReport): string {
  const { state } = report;
  switch (report.status) {
    case 'done':
      return 'Run complete.';
    case 'halted':
      return state.phase === 'paused'
        ? `Planning done — review the design and plan, then resume with: jig run --id ${state.runId}`
        : `Ready to merge "${runBranchFor(state.runId)}" — merge it, then resume with: jig run --id ${state.runId}`;
    case 'blocked':
      return `Blocked: ${report.reason} — resume with: jig run --id ${state.runId}`;
    case 'stuck':
      return stuckMessage(state);
  }
}

function stuckMessage(state: RunState): string {
  return (
    `Stuck: ${runStopReason(state) ?? 'the run exhausted its attempts'}, so jig has ended this run and will not resume it. ` +
    `Finish that slice and the rest by hand on "${runBranchFor(state.runId)}" (its pull request description is in .jig/${state.runId}/state/PR_DESCRIPTION.md), ` +
    `or start a new run with a sharper request. The failure feedback: jig status ${state.runId}`
  );
}
