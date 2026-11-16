import { Result } from 'better-result';
import { Command } from 'commander';
import { z } from 'zod';

import { runJig, type RunJigInput, type RunReport } from '../../app/run-jig.js';
import type { RunRequestInvalid } from '../../domain/errors.js';
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
import { readRequest, type RequestSource } from '../read-request.js';
import type { Invocation } from '../with-app.js';

type RunToDo = { start: RequestSource; runId?: RunId } | { resume: RunId };

export function registerRunCommand(program: Command, io?: CommandIo): void {
  program
    .command('run')
    .description(
      'Start a run from a request file (or - for standard input), or resume one with --id',
    )
    .argument(
      '[request]',
      'markdown file describing what to build, or - to read it from standard input',
    )
    .option('--id <id>', 'run id: resumes that run if it exists, otherwise names the new one')
    .addOption(configOption())
    .addOption(presetOption())
    .addOption(logFormatOption())
    .action(
      appAction(
        runInputSchema,
        async (_input, app, runInput) => {
          const report = await runJig(app, runInput);
          if (report.isErr()) return Result.err(report.error);
          app.cradle.logger.info(
            { runId: report.value.state.runId, branch: runBranchFor(report.value.state.runId) },
            nextStep(report.value),
          );
          return Result.ok();
        },
        io,
        prepareRun,
      ),
    );
}

/** The argument that asks for the request to be read from standard input. */
const STANDARD_INPUT_ARGUMENT = '-';

/**
 * `jig run [request | -] [--id <id>]`: a request file, or `-` for standard input, starts a run,
 * named by `--id` when given; an id alone resumes that run.
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
      message:
        'Pass a request file (or - for standard input) to start a run, or --id to resume one.',
    });
    return z.NEVER;
  });

function runToDo(request: string | undefined, id: RunId | undefined): RunToDo | undefined {
  if (request !== undefined) {
    const start =
      request === STANDARD_INPUT_ARGUMENT ? { stdin: true as const } : { file: request };
    return id ? { start, runId: id } : { start };
  }
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

async function prepareRun(
  { run }: z.output<typeof runInputSchema>,
  { cwd, standardInput }: Invocation,
): Promise<Result<RunJigInput, RunRequestInvalid>> {
  if ('resume' in run) return Result.ok(run);
  const start = await readRequest(run.start, { cwd, standardInput });
  return start.map((request) =>
    run.runId ? { start: request, runId: run.runId } : { start: request },
  );
}
