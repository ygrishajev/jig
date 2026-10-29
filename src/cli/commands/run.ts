import { Command, Option } from 'commander';
import { createAppContainer } from '../../app/container.js';
import { runSdlc, type RunReport } from '../../app/run-sdlc.js';
import { defaultLogFormat, type LogFormat } from '../../adapters/logging/create-logger.js';
import { withErrorHandling } from '../with-error-handling.js';

const NEXT_STEP: Record<RunReport['status'], (report: RunReport) => string> = {
  done: () => 'Run complete.',
  halted: ({ state }) =>
    state.phase === 'paused'
      ? `Planning done — review the design and plan, then resume with: sdlc run --id ${state.runId}`
      : `Ready to merge "sdlc/run/${state.runId}" — merge it, then resume with: sdlc run --id ${state.runId}`,
  blocked: ({ state }) =>
    `Blocked: ${state.blockedReason} — resume with: sdlc run --id ${state.runId}`,
  stuck: ({ state }) => `Stuck — a slice needs a person. See: sdlc status ${state.runId}`,
};

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
          const app = createAppContainer({ repoRoot: process.cwd(), logFormat: options.logFormat });
          try {
            const report = await runSdlc(app, { requestPath: request, runId: options.id });
            app.cradle.logger.info(
              { runId: report.state.runId, worktree: report.worktreePath },
              NEXT_STEP[report.status](report),
            );
          } finally {
            await app.dispose();
          }
        },
      ),
    );
}

export function logFormatOption() {
  return new Option('--log-format <format>', 'pretty for a terminal, json for CI and files')
    .choices(['pretty', 'json'])
    .default(defaultLogFormat());
}
