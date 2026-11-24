import type { Command } from 'commander';

import type { JigOperations, RunStatus } from '../../app/api.js';
import { runIdSchema } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import { slicesInOrder } from '../../domain/slice.js';
import { formatSummary } from '../../observers/metrics.js';
import { configInputSchema, configOption } from '../config-option.js';
import { type FailureOutput, withErrorHandling } from '../with-error-handling.js';
import { withInput } from '../with-input.js';

export function registerStatusCommand(
  program: Command,
  status: JigOperations['status'],
  failureOutput?: FailureOutput,
): void {
  program
    .command('status')
    .description('Show where a run is, without changing anything')
    .argument('<id>', 'run id')
    .addOption(configOption())
    .action(
      withErrorHandling(
        withInput(statusInputSchema, async ({ id, config }) => {
          const found = await status({ runId: id, configPath: config });
          return found.map((run) => {
            console.log(describeRun(run));
          });
        }),
        failureOutput,
      ),
    );
}

const statusInputSchema = configInputSchema.extend({ id: runIdSchema });

export function describeRun({ state, documents, metrics }: RunStatus): string {
  const slices = slicesInOrder(state.slices).map((slice) => {
    const line = `  [${slice.status}] ${slice.id} — ${slice.title}`;
    return slice.lastFeedback ? `${line}\n      feedback: ${slice.lastFeedback}` : line;
  });
  return [
    `Run ${state.runId} — ${state.phase} (base: ${state.baseBranch})`,
    ...(state.blockedReason ? [`Blocked: ${state.blockedReason}`] : []),
    ...(state.phase === 'completed'
      ? [`Finished without merging — "${runBranchFor(state.runId)}" is ready for review.`]
      : []),
    `${'branch'.padEnd(18)} ${runBranchFor(state.runId)}`,
    ...documents.map((document) => `${document.name.padEnd(18)} ${document.path}`),
    ...(slices.length > 0 ? ['Slices:', ...slices] : []),
    ...(metrics.steps > 0 ? [`So far: ${formatSummary(metrics)}`] : []),
  ].join('\n');
}
