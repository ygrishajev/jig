import { Command } from 'commander';
import { z } from 'zod';

import { defaultLogFormat } from '../../adapters/logging/create-logger.js';
import { readRunStatus, type RunStatus } from '../../app/run-status.js';
import { runIdSchema } from '../../domain/run-id.js';
import { runBranchFor } from '../../domain/run-state.js';
import { slicesInOrder } from '../../domain/slice.js';
import { formatSummary } from '../../observers/metrics.js';
import { withApp } from '../with-app.js';
import { withErrorHandling } from '../with-error-handling.js';
import { withInput } from '../with-input.js';

export function registerStatusCommand(program: Command) {
  program
    .command('status')
    .description('Show where a run is, without changing anything')
    .argument('<id>', 'run id')
    .action(
      withErrorHandling(
        withInput(z.object({ id: runIdSchema }), async ({ id }) => {
          await withApp(defaultLogFormat(), async (app) => {
            const status = await readRunStatus(app, id);
            console.log(describeRun(status));
            if (status.metrics.steps > 0) console.log(`So far: ${formatSummary(status.metrics)}`);
          });
        }),
      ),
    );
}

export function describeRun({ state, documents }: RunStatus) {
  const slices = slicesInOrder(state.slices).map((slice) => {
    const line = `  [${slice.status}] ${slice.id} — ${slice.title}`;
    return slice.lastFeedback ? `${line}\n      feedback: ${slice.lastFeedback}` : line;
  });
  return [
    `Run ${state.runId} — ${state.phase} (base: ${state.baseBranch})`,
    ...(state.blockedReason ? [`Blocked: ${state.blockedReason}`] : []),
    `${'branch'.padEnd(18)} ${runBranchFor(state.runId)}`,
    ...documents.map((document) => `${document.name.padEnd(18)} ${document.path}`),
    ...(slices.length > 0 ? ['Slices:', ...slices] : []),
  ].join('\n');
}
