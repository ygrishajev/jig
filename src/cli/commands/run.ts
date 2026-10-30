import { Command, Option } from 'commander';
import { runInputFrom, runSdlc, type RunReport } from '../../app/run-sdlc.js';
import { defaultLogFormat, type LogFormat } from '../../adapters/logging/create-logger.js';
import { runBranchFor, stuckSlice, type RunState } from '../../domain/run-state.js';
import { withApp } from '../with-app.js';
import { withErrorHandling } from '../with-error-handling.js';

function nextStep(report: RunReport) {
  const { state } = report;
  switch (report.status) {
    case 'done':
      return 'Run complete.';
    case 'halted':
      return state.phase === 'paused'
        ? `Planning done — review the design and plan, then resume with: sdlc run --id ${state.runId}`
        : `Ready to merge "${runBranchFor(state.runId)}" — merge it, then resume with: sdlc run --id ${state.runId}`;
    case 'blocked':
      return `Blocked: ${report.reason} — resume with: sdlc run --id ${state.runId}`;
    case 'stuck':
      return stuckMessage(state);
  }
}

function stuckMessage(state: RunState) {
  return (
    `Stuck: slice "${stuckSlice(state)?.id}" hit the review cap, so sdlc has ended this run and will not resume it. ` +
    `Finish that slice and the rest by hand on "${runBranchFor(state.runId)}" (its pull request description is in .sdlc/${state.runId}/state/PR_DESCRIPTION.md), ` +
    `or start a new run with a sharper request. The reviewer's feedback: sdlc status ${state.runId}`
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
        async (request: string | undefined, options: { id?: string; logFormat: LogFormat }) => {
          await withApp(options.logFormat, async (app) => {
            const report = await runSdlc(app, runInputFrom(request, options.id));
            app.cradle.logger.info(
              { runId: report.state.runId, branch: runBranchFor(report.state.runId) },
              nextStep(report),
            );
          });
        },
      ),
    );
}

export function logFormatOption() {
  return new Option('--log-format <format>', 'pretty for a terminal, json for CI and files')
    .choices(['pretty', 'json'])
    .default(defaultLogFormat());
}
