import { Command } from 'commander';
import path from 'node:path';
import { loadConfig } from '../../config/load-config.js';
import { prepareRun } from '../../orchestrator/prepare.js';
import { runReconcilerPass, type ReconcilePassInput } from '../../orchestrator/reconcile.js';
import { MarkdownFileInputSource } from '../../strategies/input-source/markdown-file.js';
import { writeRunResult } from '../../state/store.js';
import type { RunPaths } from '../../state/run-paths.js';
import { loadCliRunContext, selectProvider } from '../run-context.js';
import { printRunSummary } from '../run-summary.js';
import { withErrorHandling } from '../with-error-handling.js';

export type AutopilotInput = ReconcilePassInput;

export interface AutopilotResult {
  complete: boolean;
  blockedReason?: string;
  passes: number;
}

// A hard cap, not a tuning knob: prepareRun (Task 10) sets currentSliceId so
// the reconciler always has an actionable slice, and every non-blocked
// outcome moves a slice forward by one status. This guard exists purely so a
// future regression in that contract fails loudly with a clear error instead
// of hanging the process.
const MAX_RECONCILER_PASSES = 500;

export async function runAutopilot(input: AutopilotInput): Promise<AutopilotResult> {
  let passes = 0;
  while (passes < MAX_RECONCILER_PASSES) {
    passes += 1;
    const result = await runReconcilerPass(input);
    if (result.complete) return { complete: true, passes };
    if (result.blocked) return { complete: false, blockedReason: result.reason, passes };
  }
  throw new Error(
    `Autopilot made no determination after ${MAX_RECONCILER_PASSES} reconciler passes — this indicates a bug in the reconciler, not a slow run.`,
  );
}

/**
 * Writes the run's outcome to a structured file (`result.json` in the
 * run's state dir), alongside the existing human-readable console line —
 * so a caller like a CI workflow can read `{ complete, blockedReason }`
 * directly instead of grepping stdout, which also carries whatever an
 * agent itself printed (see docker-cli.ts's provider.run).
 */
async function reportAutopilotResult(
  paths: RunPaths,
  runId: string,
  result: AutopilotResult,
): Promise<void> {
  await writeRunResult(paths, {
    runId,
    complete: result.complete,
    blockedReason: result.blockedReason,
    passes: result.passes,
  });
  console.log(
    result.complete
      ? `Run ${runId} complete after ${result.passes} pass(es).`
      : `Run ${runId} blocked after ${result.passes} pass(es): ${result.blockedReason}`,
  );
}

export function registerAutopilotCommands(program: Command): void {
  program
    .command('autopilot')
    .requiredOption('--input <file>', 'path to a markdown request file')
    .option('--run-id <id>', 'use this run id instead of generating one')
    .action(
      withErrorHandling(async (opts: { input: string; runId?: string }) => {
        const repoRoot = process.cwd();
        const config = loadConfig(repoRoot);
        const provider = selectProvider(config, 'reviewer');
        const implementProvider = selectProvider(config, 'implementer');
        const meta = await prepareRun({
          repoRoot,
          inputSource: new MarkdownFileInputSource(opts.input),
          provider: selectProvider(config, 'planner'),
          runId: opts.runId,
        });
        const context = await loadCliRunContext(repoRoot, meta.runId);
        if (config.designGate === 'checkpoint') {
          console.log(`Design: ${path.join(context.paths.stateDir, 'design.md')}`);
          console.log(`Plan:   ${path.join(context.paths.stateDir, 'plan.md')}`);
          console.log(
            `Run ${meta.runId} planning complete — review the design and plan, then run ` +
              `sdlc resume --run ${meta.runId} to start implementation.`,
          );
          return;
        }
        const result = await runAutopilot({ ...context, provider, implementProvider });
        await printRunSummary(context);
        await reportAutopilotResult(context.paths, meta.runId, result);
      }),
    );

  program
    .command('resume')
    .requiredOption('--run <id>', 'run id')
    .action(
      withErrorHandling(async (opts: { run: string }) => {
        const repoRoot = process.cwd();
        const context = await loadCliRunContext(repoRoot, opts.run);
        const provider = selectProvider(context.config, 'reviewer');
        const implementProvider = selectProvider(context.config, 'implementer');
        const result = await runAutopilot({ ...context, provider, implementProvider });
        await printRunSummary(context);
        await reportAutopilotResult(context.paths, opts.run, result);
      }),
    );
}
