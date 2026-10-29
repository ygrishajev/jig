import { Command } from 'commander';
import { LocalRunStore } from '../../adapters/local-store/local-run-store.js';
import { MetricsLog } from '../../adapters/local-store/metrics-log.js';
import { formatSummary, summarizeMetrics } from '../../observers/metrics.js';
import { runBranchFor, type RunState } from '../../domain/run-state.js';
import { withErrorHandling } from '../with-error-handling.js';

export function registerStatusCommand(program: Command) {
  program
    .command('status')
    .description('Show where a run is, without changing anything')
    .argument('<id>', 'run id')
    .action(
      withErrorHandling(async (id: string) => {
        const repoRoot = process.cwd();
        const store = new LocalRunStore(repoRoot);
        const state = await store.load(id);
        if (!state) throw new Error(`No run found with id "${id}".`);
        const metrics = summarizeMetrics(new MetricsLog(repoRoot, id).readAll());
        console.log(describeRun(state, store));
        if (metrics.steps > 0) console.log(`So far: ${formatSummary(metrics)}`);
      }),
    );
}

function describeRun(state: RunState, store: LocalRunStore) {
  const documents = (['design.md', 'plan.md', 'PR_DESCRIPTION.md'] as const)
    .map((name) => [name, store.documentPath(state.runId, name)] as const)
    .filter((entry): entry is readonly [(typeof entry)[0], string] => entry[1] !== undefined)
    .map(([name, file]) => `${name.padEnd(18)} ${file}`);
  const slices = [...state.slices]
    .sort((a, b) => a.order - b.order)
    .map((slice) => {
      const line = `  [${slice.status}] ${slice.id} — ${slice.title}`;
      return slice.lastFeedback ? `${line}\n      feedback: ${slice.lastFeedback}` : line;
    });
  return [
    `Run ${state.runId} — ${state.phase} (base: ${state.baseBranch})`,
    ...(state.blockedReason ? [`Blocked: ${state.blockedReason}`] : []),
    `${'branch'.padEnd(18)} ${runBranchFor(state.runId)}`,
    ...documents,
    ...(slices.length > 0 ? ['Slices:', ...slices] : []),
  ].join('\n');
}
