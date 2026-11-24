import { Result } from 'better-result';
import { Command } from 'commander';
import { z } from 'zod';

import type { RequestInputs } from '../../adapters/terminal/standard-input.js';
import type { JigOperations, RunReport, RunRequest, RunRequestInvalid } from '../../app/api.js';
import { type RunId, runIdSchema } from '../../domain/run-id.js';
import { runBranchFor, type RunState, runStopReason } from '../../domain/run-state.js';
import type { LogFormat } from '../../ports/observability.js';
import {
  configInputSchema,
  configOption,
  presetInputSchema,
  presetOption,
} from '../config-option.js';
import { logFormatInputSchema, logFormatOption } from '../log-format-option.js';
import { readRequest, type RequestSource } from '../read-request.js';
import { type FailureOutput, withErrorHandling } from '../with-error-handling.js';
import { withInput } from '../with-input.js';

/** Where the run command reads its request from and tells the operator what to do next. */
export interface RunCommandIo {
  requestInputs: RequestInputs;
  outcomeLog(format: LogFormat): OutcomeLog;
}

export interface OutcomeLog {
  info(details: object, message: string): void;
}

type RunToDo = { start: RequestSource; runId?: RunId; merge: boolean } | { resume: RunId };

export function registerRunCommand(
  program: Command,
  run: JigOperations['run'],
  { requestInputs, outcomeLog }: RunCommandIo,
  failureOutput?: FailureOutput,
): void {
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
    .option(
      '--no-merge',
      'describe the result and stop without merging; the run ends "completed" (ignored when resuming an existing run)',
    )
    .addOption(configOption())
    .addOption(presetOption())
    .addOption(logFormatOption())
    .action(
      withErrorHandling(
        withInput(runInputSchema, async ({ run: toDo, config, preset, logFormat }) => {
          const request = await runRequestOf(toDo, requestInputs);
          if (request.isErr()) return Result.err(request.error);
          const report = await run({ run: request.value, configPath: config, preset, logFormat });
          return report.map((stopped) => {
            const { runId } = stopped.state;
            outcomeLog(logFormat).info({ runId, branch: runBranchFor(runId) }, nextStep(stopped));
          });
        }),
        failureOutput,
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
  .extend({
    request: z.string().optional(),
    id: runIdSchema.optional(),
    merge: z.boolean().default(true),
  })
  .transform(({ request, id, merge, ...options }, context) => {
    const run = runToDo(request, id, merge);
    if (run) return { run, ...options };
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        'Pass a request file (or - for standard input) to start a run, or --id to resume one.',
    });
    return z.NEVER;
  });

function runToDo(
  request: string | undefined,
  id: RunId | undefined,
  merge: boolean,
): RunToDo | undefined {
  if (request !== undefined) {
    const start =
      request === STANDARD_INPUT_ARGUMENT ? { stdin: true as const } : { file: request };
    return id ? { start, runId: id, merge } : { start, merge };
  }
  if (id) return { resume: id };
  return undefined;
}

/** Reads the request a start names before any operation is asked for, so a refusal opens nothing. */
async function runRequestOf(
  toDo: RunToDo,
  inputs: RequestInputs,
): Promise<Result<RunRequest, RunRequestInvalid>> {
  if ('resume' in toDo) return Result.ok(toDo);
  const start = await readRequest(toDo.start, inputs);
  return start.map((request) => {
    const started = { ...request, merge: toDo.merge };
    return toDo.runId ? { start: started, runId: toDo.runId } : { start: started };
  });
}

/** What the operator does next, for where the run stopped. */
export function nextStep(report: RunReport): string {
  const { state } = report;
  switch (report.status) {
    case 'done':
      return 'Run complete.';
    case 'completed':
      return `Run finished without merging — review and merge "${runBranchFor(state.runId)}" yourself (its pull request description is in ${prDescriptionPath(state)}).`;
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

function prDescriptionPath(state: RunState): string {
  return `.jig/${state.runId}/state/PR_DESCRIPTION.md`;
}

function stuckMessage(state: RunState): string {
  return (
    `Stuck: ${runStopReason(state) ?? 'the run exhausted its attempts'}, so jig has ended this run and will not resume it. ` +
    `Finish that slice and the rest by hand on "${runBranchFor(state.runId)}" (its pull request description is in ${prDescriptionPath(state)}), ` +
    `or start a new run with a sharper request. The failure feedback: jig status ${state.runId}`
  );
}
