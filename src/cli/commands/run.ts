import { Command } from 'commander';
import { z } from 'zod';

import { runJig, type RunJigInput, type RunReport } from '../../app/run-jig.js';
import { type RunId, runIdSchema } from '../../domain/run-id.js';
import { runBranchFor, type RunState, stuckSlice } from '../../domain/run-state.js';
import { logFormatInputSchema, logFormatOption } from '../log-format-option.js';
import { withApp } from '../with-app.js';
import { withErrorHandling } from '../with-error-handling.js';
import { withInput } from '../with-input.js';

/**
 * `jig run [request] [--id <id>]`: a request starts a run, named by `--id` when given; an id
 * alone resumes that run.
 */
export const runInputSchema = logFormatInputSchema
  .extend({ request: z.string().optional(), id: runIdSchema.optional() })
  .transform(({ request, id, logFormat }, context) => {
    const run = runToDo(request, id);
    if (run) return { run, logFormat };
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
export function nextStep(report: RunReport) {
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

function stuckMessage(state: RunState) {
  return (
    `Stuck: slice "${stuckSlice(state)?.id}" hit the review cap, so jig has ended this run and will not resume it. ` +
    `Finish that slice and the rest by hand on "${runBranchFor(state.runId)}" (its pull request description is in .jig/${state.runId}/state/PR_DESCRIPTION.md), ` +
    `or start a new run with a sharper request. The reviewer's feedback: jig status ${state.runId}`
  );
}

export function registerRunCommand(program: Command) {
  program
    .command('run')
    .description('Start a run from a request file, or resume one with --id')
    .argument('[request]', 'markdown file describing what to build')
    .option('--id <id>', 'run id: resumes that run if it exists, otherwise names the new one')
    .addOption(logFormatOption())
    .action(
      withErrorHandling(
        withInput(runInputSchema, async ({ run, logFormat }) => {
          await withApp(logFormat, async (app) => {
            const report = await runJig(app, run);
            app.cradle.logger.info(
              { runId: report.state.runId, branch: runBranchFor(report.state.runId) },
              nextStep(report),
            );
          });
        }),
      ),
    );
}
