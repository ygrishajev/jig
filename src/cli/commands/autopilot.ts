import { Command } from 'commander';
import path from 'node:path';
import { loadConfig } from '../../config/load-config.js';
import { prepareRun } from '../../orchestrator/prepare.js';
import { runReconcilerPass, type ReconcilePassInput } from '../../orchestrator/reconcile.js';
import { MarkdownFileInputSource } from '../../strategies/input-source/markdown-file.js';
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

export function registerAutopilotCommands(program: Command): void {
  program
    .command('autopilot')
    .requiredOption('--input <file>', 'path to a markdown request file')
    .action(
      withErrorHandling(async (opts: { input: string }) => {
        const repoRoot = process.cwd();
        const config = loadConfig(repoRoot);
        const provider = selectProvider(config, 'reviewer');
        const implementProvider = selectProvider(config, 'implementer');
        const meta = await prepareRun({
          repoRoot,
          inputSource: new MarkdownFileInputSource(opts.input),
          provider: selectProvider(config, 'planner'),
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
        console.log(
          result.complete
            ? `Run ${meta.runId} complete after ${result.passes} pass(es).`
            : `Run ${meta.runId} blocked after ${result.passes} pass(es): ${result.blockedReason}`,
        );
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
        console.log(
          result.complete
            ? `Run ${opts.run} complete after ${result.passes} pass(es).`
            : `Run ${opts.run} blocked after ${result.passes} pass(es): ${result.blockedReason}`,
        );
      }),
    );
}
